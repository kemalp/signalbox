# Codex adapter

`packages/adapter-codex` reads what the Codex CLI, IDE extension and desktop app write under `CODEX_HOME`. It needs no credentials and opens no network connections.

```ts
import { createCodexAdapter } from "@signalbox/adapter-codex";
const codex = createCodexAdapter(); // or { codexHome, now }
```

`codexHome` is the option, then `$CODEX_HOME`, then `~/.codex`.

Everything below was checked on 2026-10-09 against local data written by Codex `0.154.0-alpha.6.2` through `0.158.0-alpha.2.1` (desktop app, `originator: codex_work_desktop`). That covered 10 rollouts, 3,989 lines and 440 usage records. Only key names, counts and token sums were inspected; no message content was read out.

## Sources

| Source | Path | Used for | Stability |
|---|---|---|---|
| Rollouts | `sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl` (also `.jsonl.zst`) | usage, limits, context, sessions, compactions | internal |
| Archived rollouts | `archived_sessions/rollout-*.jsonl` | usage, limits | internal |
| Session index | `session_index.jsonl` (`{id, thread_name, updated_at}`) | session names | internal |

None of these formats is documented by OpenAI. Every source is badged *internal*, and parsing is defensive: optional fields, unknown line types counted and passed over, bad lines skipped.

**Never opened:** `auth.json`, `config.toml`, the SQLite files, and any file whose name contains `auth`, `token`, `credential` or `oauth`. A guard in `src/io.ts` refuses those names before any read, and the tests check this with a mode-000 decoy `auth.json` and an IO spy.

## Rollout line format

Each line is `{"timestamp": ISO-8601 UTC, "ordinal": n, "type": …, "payload": {…}}`. Current writers put the keys in exactly that order, with `payload.type` first. The adapter uses that prefix to skip message, reasoning and tool lines without parsing them. A line whose prefix doesn't match is parsed in full. Older writers omit `ordinal`.

Line types seen: `session_meta` (always line 0), `turn_context`, `event_msg`, `response_item`, `token_usage_record`, `compacted`, `world_state`.

- **`session_meta`**: `id` (thread id; also in the file name), `session_id` (root session; differs from `id` for subagents), `parent_thread_id`, `cwd`, `cli_version`, `originator`, `source` (`"cli" | "vscode" | "exec" | "mcp"` or `{subagent: …}`), `thread_source` (`user`, `guardian_review`), `model_provider`, `timestamp`, `subagent_history_start_ordinal`.
- **`turn_context`**: `turn_id`, `model`, `effort`, `cwd`, plus sandbox and approval settings. The model id here is what gets priced.
- **`event_msg`** payload types used: `token_count`, `task_started`, `task_complete`, `turn_aborted`, `thread_settings_applied` (`thread_settings.service_tier`, `model`).
- **`token_usage_record`**: `response_id` (Responses API `resp_…`), `session_id`, `thread_id`, `turn_id`, `root_turn_id`, and three usage objects: `usage` (this response), `turn_token_usage` and `thread_token_usage` (running sums).
- **`event_msg` / `token_count`**: `info {total_token_usage, last_token_usage, model_context_window}` and `rate_limits {limit_id, limit_name, primary, secondary, credits, plan_type, individual_limit, rate_limit_reached_type, spend_control_reached}`.
- **`compacted`**: `compaction_response_id`, `latest_token_usage_record` (a copy of the compaction call's record), `window_number`, plus replacement history. The history is content and is never read.

Every usage object has `input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens`.

## Usage: one record per model response

**Source of truth: `token_usage_record`, keyed on `response_id` (`keyQuality: "id"`).** What was verified:

- 440 records carried 440 distinct `response_id`s. None repeated within a file or across files, including the three guardian-subagent rollouts, so they hold no copied parent history.
- `thread_token_usage` deltas equal `usage` on every record (430 deltas plus 10 first records).
- `usage.total_tokens == input_tokens + output_tokens` on 440/440. Also `cached + cache_write ≤ input` and `reasoning ≤ output` on 440/440.
- Per thread, the sum of `usage.total_tokens` equals Codex's own `threads.tokens_used` (in `state_5.sqlite`, opened read-only once for this check) for 9 of 10 threads. The exception is the thread with a compaction. Its compaction call (240,778 tokens) has a `token_usage_record` but no `token_count`, and Codex leaves it out of `tokens_used` too. It is a billed API call, so Signalbox counts it.

**Why not `token_count`:** the events repeat. 5 of 444 had an unchanged cumulative total, so summing `last_token_usage` would double count. They also skip the compaction call.

**Legacy fallback:** in a rollout with no `token_usage_record` (older writers), `token_count` events become records. Repeats are dropped by their unchanged `total_token_usage.total_tokens`. Their key is `<thread id>:tc:<cumulative total>`, with `keyQuality: "hash"`. In current files no `token_count` comes before the first `token_usage_record` (checked on all 10 files), so the fallback only applies before that line and can't double count.

**Cross-file dedup:** `scanUsage` dedups by id across all rollouts before applying the time filter and keeps the earliest occurrence. A forked or re-imported copy therefore can't replace an original that falls outside the range. A `token_usage_record` without a `response_id` gets a derived `hash` key from timestamp, running total and token tuple.

Other record fields:

- **model**: from the `turn_context` whose `turn_id` matches (440/440 had one), else the latest `turn_context`, else `thread_settings.model`, else `"unknown"`, which shows up as unpriced.
- **project**: the turn's `cwd`.
- **outputFinal**: always `true`, because the record is written from the completed response.
- **webSearchRequests**: `response_item` lines of type `web_search_call` since the previous record. None were seen locally.
- **speed**: from `thread_settings.service_tier`. `fast` and `priority` map to `"fast"`; `default`, `standard` and `auto` map to `"standard"`; anything else stays unknown. Every local value was `default`.
- **sessionId**: the root `session_id`, so guardian and subagent usage rolls up into the session that spawned it.
- **kind**: from `session_meta.source`. A string is `main`. `{subagent: {thread_spawn}}` and `{subagent: "review"}` are `subagent`. `{subagent: {other: "guardian"}}` (thread_source `guardian_review`, model `codex-auto-review`) and `{subagent: "compact"}` are `auxiliary`. Any other shape is `other`.

### Token normalization (OpenAI semantics)

From [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): cached and cache-write tokens are subsets of `input_tokens`, because the guide computes ordinary input as `input_tokens - cached_tokens - cache_write_tokens`. From [Reasoning](https://developers.openai.com/api/docs/guides/reasoning): reasoning tokens are billed as output tokens, and `total_tokens = input_tokens + output_tokens`.

| TokenCounts | from Codex |
|---|---|
| `input` | `input_tokens - cached_input_tokens - cache_write_input_tokens` (clamped at 0) |
| `cacheRead` | `cached_input_tokens` |
| `cacheWrite5m` | `cache_write_input_tokens`. OpenAI has one cache TTL per model (30m for GPT-5.6+), so the short-TTL slot is used and the price table holds the same rate in both write columns |
| `cacheWrite1h` | `0` |
| `output` | `output_tokens` (reasoning included) |
| `reasoning` | `reasoning_output_tokens` (informational) |

The raw Responses API shape (`input_tokens_details.cached_tokens` / `cache_write_tokens`, `output_tokens_details.reasoning_tokens`) is accepted too. `cache_write_input_tokens` was 0 on every local record (ChatGPT-plan traffic).

## Plan limits (`readLimits`)

Each `token_count.rate_limits` slot (`primary`, `secondary`) with a numeric `used_percent` becomes a `LimitSnapshot`. `resets_at` is epoch seconds and becomes an ISO string. `plan` is `plan_type` (`plus` locally). `observedAt` is the line timestamp. `windowMinutes` and `label` come from `window_minutes` (300 is "5-hour", 10080 is "Weekly").

**Kinds:** a slot carrying its usual window keeps the plain name: `codex.primary` (300) and `codex.secondary` (10080). Any other window gets its own kind, `codex.<slot>.<window>m`, and its label adds the turn's model. The reason: after the 5-hour window hit 99%, the account fell back to `gpt-reserve`. Codex then reported `limit_id: "codex"` with a 10080-minute window in the primary slot, at 0→12% with a different `resets_at`, while the regular weekly window stood at 16%. That is a separate bucket. Keying on slot or window alone would have mixed it into another gauge. It now shows as `codex.primary.10080m`, labelled "Weekly (gpt-reserve)". A `limit_id` other than `codex` is prefixed, for example `codex.premium.primary`. The local `premium` readings had both slots `null` and only `credits`, so they produce no snapshot. `credits` (`has_credits`, `unlimited`, `balance`) is not mapped, because the contract has no field for it.

**Freshest wins:** the latest reading per kind within each file, then the freshest across rollouts (including archived ones) from the 8 days before the last activity. An idle account therefore still gets its last known, expired gauges, which the UI greys out. `resets_at` jitters by a few seconds between readings.

## Context (`readContext`)

For main threads written in the last 24h, context comes from the last `token_count`: `tokens = last_token_usage.input_tokens`, `window = info.model_context_window` (258,400 locally, which is 95% of the 272K in `models_cache.json`), `percent = tokens / window`, `quality: "estimated"`. If a `compacted` line comes after that `token_count`, the size is unknown and no snapshot is emitted. For comparison, Codex's own TUI estimates context as `total_tokens - reasoning_output_tokens` of the last response.

## Sessions (`listSessions`)

Main threads whose rollout was written in the last 24h, plus `session_index.jsonl` entries updated in the last 24h that have no rollout. Archived rollouts are excluded.

- **name**: `thread_name` from the index (the newest line per id wins).
- **entrypoint**: `originator`.
- **version**: `cli_version`.
- **model / effort / cwd**: from the latest `turn_context`.
- **status**: `busy` when a `task_started` has no later `task_complete` / `turn_aborted` and the file was written in the last 5 minutes. `idle` when the last turn is closed. `unknown` otherwise; a stale open turn usually means Codex exited mid-turn.

The files expose no pid. Process scraping is out of scope.

## Compactions (`readCompactions`)

One event per `compacted` line, with `trigger: "unknown"`. `preTokens` is the compaction call's `input_tokens` from `latest_token_usage_record`, which is the context that was summarized.

## Other files seen, not used

- `state_5.sqlite`: has a `threads` table (`rollout_path`, `tokens_used`, `model`, `reasoning_effort`, `archived`, `cwd`, …) and `thread_spawn_edges`. `tokens_used` is a useful ledger cross-check, but the file is an internal SQLite in WAL mode. Here a plain `mode=ro` open failed with "unable to open database file", and only `immutable=1` worked, which can read a stale snapshot while Codex is writing. It also misses compaction calls.
- `thread_history_1.sqlite` (`thread_turns`: status, started/completed, rollout byte offsets), `logs_2.sqlite`, `models_cache.json` (per model: `slug`, `context_window`, `effective_context_window_percent`, `supported_in_api`, service tiers).

## Pricing

`pricing/openai.json` holds the Standard-tier list prices from <https://developers.openai.com/api/docs/pricing> (as of 2026-10-09), with `longContext` above 272K input tokens and `fast` rates. Read its `notes` for the details. `gpt-reserve` and `codex-auto-review` have no public API price, so they are left unpriced (shown as `unpricedModels`). For the local data that covers 220 of 440 records.

## What is likely to break

- The line prefix order. If it changes, lines simply get parsed in full: slower, but still correct.
- `token_usage_record` renamed or removed. Health reports "usage lines present but none parsed", and older-style `token_count` data still flows through the legacy path.
- New `SessionSource` shapes map to `other`, and new line types are counted in health as "unknown line types passed through".
- `.jsonl.zst` rollouts are decoded with `Bun.zstdDecompressSync`. Only the synthetic fixture has exercised this; no compressed rollout exists locally.
