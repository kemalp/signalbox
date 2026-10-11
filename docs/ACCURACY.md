# Accuracy

What Signalbox's numbers mean, how they are checked, and where they knowingly differ from the reference script. Every dollar figure is a **list-price equivalent, not a bill**.

## Recorded dollars match `cc_cost.py`

`research/cost/cc_cost.py` is the reference for Claude Code. `signalbox report` must agree with it within 0.5% on recorded USD. In practice the token totals are identical.

Rerun the check at any time:

```bash
bun apps/cli/scripts/reference-check.ts --days 7     # also --days 30, --days 60
```

The script runs `signalbox report --agent claude-code --json` and `cc_cost.py` over the same fixed window. The window ends 10 minutes ago, so lines that live sessions write during the run fall outside it. It compares responses, input, output, cache read, cache write (and its 1h part), placeholder counts and USD: in total, per model and per kind. It prints aggregates only.

`cc_cost.py` has no upper bound on its window. The script therefore pins its clock to the window end and hides assistant lines stamped at or after it. The only thing that can still differ is a response whose lines straddle the window end.

### Results on the development machine (2026-10-09)

The check ran on the developer's own transcripts. Only the agreement is recorded here, not the totals.

| Window | Responses | Tokens (input / output / cache read / cache write) | Recorded USD, signalbox vs cc_cost.py |
|---|---|---|---|
| 7 days, pinned | identical | identical in total, per model and per kind | 0.0003% apart (the reference rounds to cents) |
| 30 days, pinned | identical | identical | 0.0003% apart |
| 60 days, pinned | identical | identical | 0.0004% apart |
| 7 days, live, run back to back (`cc_cost.py --days 7 --json`, then `bun run report -- --days 7 --rolling --agent claude-code --json`; before 2026-10-10 `--days` alone was rolling) | identical | identical | 0.0000% apart |

Per kind (main, subagent, workflow), responses, tokens and dollars were identical too. Workflow responses made up most of the pinned 7 days, and every response was `claude-opus-5-5`.

Timing (wall clock, warm file cache): `bun run report -- --days 7` 0.55 s, `--days 30` 0.68 s; `cc_cost.py --days 7` 0.70 s.

## Where Signalbox deliberately differs from `cc_cost.py`

None of these changes any total on the current data, because the conditions never occur locally. They matter for other machines and future Claude Code versions.

| Case | cc_cost.py | Signalbox | Why |
|---|---|---|---|
| A response has no 5m/1h cache-write split | Prices the remainder as 5m writes | Main sessions as 1h, subagents and workflows as 5m | Main sessions write a 1-hour cache on a subscription (BRAINSTORM §6.5); Claude Code's own ledger implies exactly 2.0x write pricing for main-only sessions. No local cache-write row lacks the split. |
| `usage.iterations[]` with several entries, or another model | Ignored | Priced per iteration, flagged `iteration-split` | Guards against the ccusage #1710 class of bug. Iteration usage is never added on top of the top-level usage. No local response has more than one iteration. |
| No `message.id` and no `requestId` | Falls back to the line `uuid` | A hash of session, agent, timestamp and usage, flagged `hash` | Each streamed line has its own uuid, so a uuid key would count one response once per content block. No local line needs either fallback. |
| Assistant line without `usage` | Counted as a zero-usage response | Dropped | It is not an API response with known usage. None exist locally. |
| Unrecorded output estimate | Estimated from message text length | Not computed | Signalbox never reads message content. Missing output is handled by the ledger calibration below instead. |
| Project | Encoded project folder name | The session's first main-thread `cwd` | Same session grouping, with a readable absolute path. |
| Window end | Open-ended | `[since, until)` | Lets reports cover a fixed past window. |

## Recorded vs estimated

**Recorded** is the sum of transcript-priced responses. It is a lower bound, for two reasons:

- **Placeholder output.** Responses that never get a `stop_reason` line keep the streaming placeholder as their output count. Over the last 7 days that is 98.6% of subagent and 93.8% of workflow responses (0% of main-thread responses).
- **Calls that never reach transcripts,** such as auxiliary Haiku calls.

**Estimated** calibrates recorded against Claude Code's own `cost-state` ledger, per model:

1. For every session that has both, price the transcript tokens and the ledger tokens **with the same price table**, so a price-table disagreement (for example Sonnet 5.5 cache reads, $0.10 on the pricing page against $0.20 in Claude Code's ledger) does not look like missing data.
2. k = transcript $ / ledger $, capped at 1. Ledgers smaller than their transcript by more than 2% are stale (written before a resume) and left out.
3. A session/model that has a usable ledger counts at its ledger figure, pro-rated to the range by its transcript $ in range. Only spend without a usable ledger is extrapolated as recorded / k per model. The range uses the ledger-weighted 25th and 75th percentiles of per-session k, widened to include the pooled k. Spend that exists only in a ledger (models a session's transcripts never show) is added, pro-rated to the range.
4. Session/model pairs with k below 0.5 are dominated by calls that never reach transcripts (for example auxiliary Haiku input), not by placeholder output. They count at their ledger figure and are left out of k; otherwise one tiny transcript call could turn a session's auxiliary spend into a divisor for every other session's spend on that model.

Reconciliation compares **whole sessions**, because a ledger covers its whole session. The CLI and the server therefore scan with `wholeSessions: true`: every record of every session that has activity in the range. The report's totals still cover only the range.

The ledger has no 5m/1h cache-write split, and a main session's ledger also covers its subagents and workflows, which write 5-minute caches. Core re-splits each ledger row's cache writes by that session's own transcript share for the same model, and prices them as 1h only when the transcript has no cache writes for the model. Pricing all of them as 1h would overstate the ledger by about 15% on the development machine and pull k from about 0.85 down to about 0.74.

On the development machine, the 7-day estimate came out 9–24% above recorded, with a median per-session k of 0.90 (range 0.66–1.00). That agrees with BRAINSTORM §6.6 (18–29% above recorded). With ledger sessions counted at their own ledger figure (step 3), the 7-day window ending 2026-10-09 reads 20–22% above recorded: close to 90% of the estimate is ledger spend, so the range is narrow. The text report's "Session k" line is the whole-session k across all models, for orientation; the k values the estimate uses are listed per model in the estimate method.

## Windows

- "N days" means N calendar days in local time everywhere: `signalbox report --days N`, `watch` and `snapshot --days N`, the web page's Today, 7d and 30d, and the app. Today starts at local midnight; 7 days start at local midnight six days ago. `byDay` then has exactly N rows. With `--until`, `report --days N` covers the N days that end with the day `--until` falls in (the N days before it when `--until` is exactly midnight).
- `signalbox report --days N --rolling` is a rolling window of N × 24 hours ending now, the same as `cc_cost.py --days N`. The reference check above doesn't depend on either: it pins an explicit `--since`/`--until`.
- `--since` and `--until` take `YYYY-MM-DD` (local midnight) or an ISO timestamp; `--until` is exclusive.
- The fleet's session cost and compactions cover 7 calendar days too.

## Codex

- Usage comes from `token_usage_record` lines, one per Responses API `response_id`. Codex's own `token_count` totals leave out compaction calls, which are billed (one local compaction call was about 240k tokens), so Signalbox's Codex token totals can exceed what Codex itself reports.
- Codex has no local cost ledger, so Codex estimated equals recorded.
- `codex-auto-review` (the Guardian approval reviewer) and `gpt-reserve` have no published API price. They are counted at $0 and listed as unpriced, never guessed.

## Context windows

- **Fill.** An official reading (the tap spool) is what Claude Code itself reports. Without one, the fill is estimated from the session's last main-thread request: input + cache reads + cache writes, the prompt it sent (`quality: "estimated"`). Codex fills come from its own `token_count` lines.
- **Window.** A window that the agent reports with the reading wins: the tap spool's, or Codex's `model_context_window` (`windowSource: "agent"`). Otherwise the window is the model's documented size from [`models/anthropic.json`](../models/anthropic.json) (`windowSource: "model-table"`). Every entry there names the official page it came from and the date it was read. On 2026-10-10 every current Claude model had a 1M-token window, and Opus 4.5, Sonnet 4.5, Haiku 4.5 and older models had 200k. A Claude Code model id ending in `[1m]` means a 1M window.
- **Never guessed.** A model with no entry has no window. A prompt larger than the documented window means the session runs a bigger window than the table knows (a 1M variant whose id doesn't show it), so that window is dropped too. Either way the page and the app show tokens and "window unknown", not a percent.
- **Auto-compact marker.** Claude Code 2.1.293 auto-compacted a claude-opus-5-5 session at 967,000 of 1,000,000 tokens (96.7%; the desktop app showed 97%). That was observed on this machine, not documented, so it is marked `internal` in the model file. The marker appears only on Claude Code sessions with a 1M window, the only window observed. A user who turned auto-compact off or changed its threshold still sees the default marker, because that setting isn't in the files Signalbox reads.

## Unknown is not zero

A model with no price row is priced at $0 and listed in `unpricedModels`. A context reading without a known window (an unknown model) shows tokens and "window unknown", not a percent. Plan limits without a tap spool read "unknown". Session cost on a fleet card is undefined when the session had no activity in the last 7 days.
