# DeepSeek Harness adapter

`packages/adapter-deepseek` reads the session logs that DeepSeek Harness (the desktop app and its `dsh` command) writes under its home. It needs no credentials and opens no network connections.

```ts
import { createDeepseekAdapter } from "@signalbox/adapter-deepseek";
const dsh = createDeepseekAdapter(); // or { dshHome, now }
```

`dshHome` is the option, then `$DSH_HOME` (unless it is blank), then `~/.dsh`. That is the harness's own rule.

Everything below was checked on 2026-11-10 against local data written by DeepSeek Harness `0.2.2-rc.1` (desktop app). That covered 32 logs (30 in format v4, 2 in the first generation), 7,828 frames, 21,024 lines and 2,225 responses. Only key names, event type names, counts and token sums were inspected; no message content was read out. The layout, the frame encoding and the title sources are also described in the package notes the harness ships inside its app (`dsh-session-persistence-jsonl`, `dsh-session-title`, `dsh-home-paths`), and they agree with the data.

## Sources

| Source | Path | Used for | Stability |
|---|---|---|---|
| Session logs | `sessions/<project folder>/<session folder>/session.vN.jsonl.zstd` (the first generation is `session.jsonl.zstd`; a home set up without compression has `.jsonl`) | usage, sessions, context, compactions, titles | internal |

The harness describes this layout in its own notes, but it also says the compressed log "must be read through the backend": it is the harness's storage, not an interface for other tools. So the source is badged *internal*, and parsing is defensive: optional fields, unknown event types counted and passed over, bad lines skipped.

**Never opened:** `.credentials.yaml`, the settings files (`settings.yaml*`, `cordis.patch.yml` and the profiles' `cordis.yml`, where provider keys can live), `storages/`, `attachments/`, `cache/`, `session.lock`, and the desktop app's own folder (`~/Library/Application Support/@deepseek-ai`, a browser profile with cookies). An allow-list in `src/io.ts` lets a read through only for `sessions/<project>/<session>/session[.vN].jsonl[.zstd]`. Directory listings and `lstat` stay inside `sessions/`, and a symbolic link is never followed. The tests check this with mode-000 decoys and an IO spy.

`session.lock` is the harness's writer lock (`flock`). The adapter never opens or locks it, so it cannot get in the harness's way. The price is that it cannot tell whether a session is open in an app right now (see [Sessions](#sessions-listsessions)).

## Log format

A session folder holds one log per format generation. The highest generation is the session; the harness keeps the older ones after a migration, and the adapter never reads them once a newer one exists (they hold the same responses).

**Frames.** A compressed log is a concatenation of independent Zstandard frames: one for the header line, then one per append batch, each with a checksum. The adapter walks the frame and block headers (RFC 8878) to find where each frame ends, and inflates whole frames only:

- A frame still being written, or torn by a crash, is left alone until it is whole.
- A frame that fails its checksum stops the read there. Health and `doctor` say so; the frames before it still count.
- A log only ever grows. The adapter remembers where it stopped and the 32 bytes before that point, and reads a grown log from there. If those bytes have changed, the file is not the log it knew, and it is read from the start.
- Frames are inflated about 1 MiB at a time and the file is read in 8 MiB windows, so a long log is never in memory whole.

A plain `.jsonl` log is read the same way, by whole lines.

**Lines.** The first line is the header: `{"type":"session","version":4,"id","createdAt","cwd","parentSession","origin","isSeeded","delegationDepth","agentPreset"}`. Every other line is an event: `{"type":"…","seq":n,"time":epoch ms,"data":{…}}`. All 20,991 event lines seen had the keys in exactly that order, so the adapter reads the type from the line's prefix and passes over the lines it does not need (user, system and tool lines, request headers) without parsing them. A line whose prefix does not match is parsed in full.

Events used:

- **`assistant/message`**: `data.usage` (or the last `usage` chunk of `data.stream`), `data.message.id`, `data.message.source.model`, `data.interrupted`.
- **`assistant/attempt`**: a model call that was retried; only the last `usage` chunk of its stream.
- **`request/context`**: `model`, `provider`, `contextWindow`. **`model/selection`**: `model`, `provider`, `reasoningEffort`.
- **`turn/start`**, **`turn/end`**, **`approval/asked`** (`id` only), **`approval/decided`** (`id`).
- **`compaction/start`** (`compactionId`, `sourceCommandId`), **`compaction/summary`** (`usage`, `model`), **`compaction/end`** (`error`).
- **`session/title`**: `title`, `source.kind`. **`session/end-seed`**: `inherited`. **`working-directory/change`**: `cwd`.
- **`tool-workflow/run-start`**, **`tool-workflow/agent-start`** (`childId`).

An event type outside the harness's 0.2.2-rc.1 vocabulary is counted, and health names it ("unknown event types passed over"). Events from plugins (`plugin:…`) are not counted.

## Usage: one record per model call

**Source of truth: `assistant/message`, keyed on `data.message.id` (`keyQuality: "id"`).** What was verified:

- 2,225 messages carried 2,195 distinct ids. The 30 repeats were the same 15 messages in the inherited start of two forked sessions (see below). No id repeated anywhere else.
- 2,224 messages had a usage object. On the 2,223 that carry `totalTokens`, it equals `inputTokens + outputTokens + cacheReadTokens`. So `inputTokens` is the uncached part already; the harness's own token meter names it `uncachedInputTokens`.
- The one message without usage was interrupted before the provider reported any. It produces no record.

| TokenCounts | from the log |
|---|---|
| `input` | `inputTokens` |
| `cacheRead` | `cacheReadTokens` |
| `cacheWrite5m` | `cacheWriteTokens`. The log has one figure with no TTL, so the short-TTL slot is used. None was seen locally |
| `cacheWrite1h` | `0` |
| `output` | `outputTokens` (reasoning included) |
| `reasoning` | `reasoningTokens`, when a provider reports it (informational). None was seen locally |

Other calls that are counted:

- **A retried call** (`assistant/attempt`) never becomes a message, but when the provider reported usage for it, it was a response. It gets a record keyed `<session>:attempt:<seq>` (`keyQuality: "request"`, flag `retried-attempt`). All 17 local attempts with a usage chunk were transport, timeout or server errors with zero tokens, so none produced a record.
- **The summarizing call of a compaction** (`compaction/summary.usage`) is a response of its own, on the model that wrote the summary. It gets a record keyed `<session>:compaction:<compactionId>` with `kind: "auxiliary"`. One was seen locally (628,829 tokens).

Calls that are **not** counted, because the log holds no usage for them: generating a session title (`session/title-llm-request`) and the harness's search helper calls. Recorded dollars are therefore a lower bound, as for the other agents.

**Forks.** A forked session's log starts with a copy of its parent's events, ids and timestamps unchanged, up to a `session/end-seed` line with `inherited: true`. The usage, compactions and workflow runs in that copy are the parent's and are left out: they are counted in the parent's log. Until the mark is read, nothing in a seeded log counts. `scanUsage` still dedups by id across every log and keeps the earliest copy, which covers a log copied by hand.

Other record fields:

- **model**: `data.message.source.model` as logged, for example `deepseek-v4-pro` or `kimi-k3.1-pro:cloud`. The harness runs on whichever provider a session picks (locally: `ollama`, `opencode-go`, `deepseek-official`, `anthropic`); the provider is not part of the id. Without a source, the model of the last `request/context`, else `"unknown"`, which shows up as unpriced.
- **project**: the header's `cwd`, or the last `working-directory/change` before the response.
- **outputFinal**: `true`, except on a message marked `interrupted`.
- **sessionId**: the session the user started. A session it delegated (`parentSession` in the header) rolls up into it, through as many levels as the logs on disk show.
- **kind**: `main` for a session the user started; `subagent` for one it delegated; `workflow` when the parent logged a `tool-workflow/agent-start` with that session's id; `auxiliary` for compaction calls.

## Pricing

Records are priced by model id, like every agent's.

- [`pricing/deepseek.json`](../../pricing/deepseek.json): DeepSeek's list prices, with its peak and off-peak tiers. A response is priced by its own timestamp against the page's peak hours (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday); off-peak is half price. Chinese public holidays, which the page also treats as off-peak, are not modelled.
- [`pricing/moonshot.json`](../../pricing/moonshot.json): the Kimi API's list prices.
- A session that runs Claude models through the harness is priced from `pricing/anthropic.json`, like anywhere else.

**Models reached through a host with no price list.** Ollama Cloud and OpenCode Go sell plans, not tokens, and name the models their own way: `kimi-k3.1-pro:cloud`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash:cloud`. Those three ids are listed in the model maker's table at the maker's own API rates, each with a note saying so. That is the same meaning every Signalbox dollar has: what the tokens would cost at the published API price. Remove a row to leave that model unpriced instead. Anything not listed (`hy4-preview` and `glm-5.2:cloud` locally) is counted at $0 and listed as unpriced; nothing is guessed.

The harness keeps no cost ledger, so estimated equals recorded.

## Context (`readContext`)

For sessions the user started whose log was written in the last 24h: `tokens` is the prompt size of the last response (`inputTokens + cacheReadTokens + cacheWriteTokens`), `window` is the `contextWindow` of the `request/context` in force (`windowSource: "agent"`; 1,000,000 to 1,048,576 locally), `quality: "estimated"`. If a compaction finished after that response, the size is unknown until the next one, and no snapshot is emitted.

## Sessions (`listSessions`)

Sessions the user started whose log was written in the last 24h.

- **name**: the session's title (see below).
- **model / effort**: the last `model/selection` or `request/context`.
- **cwd**: the header's, or the last `working-directory/change`.
- **status**: `waiting` (with `waitingFor: "permission prompt"`) when the open turn has an `approval/asked` with no `approval/decided`, in the session or in one it delegated. `busy` when a `turn/start` has no `turn/end` and the session's log, or the log of a session it delegated, was written in the last 5 minutes. `idle` when the last turn is closed. `unknown` otherwise; a stale open turn usually means the app was quit mid-turn.

The log has no pid, and the lock file is never touched, so a session that is idle in a closed app still shows as idle until it drops out of the 24h window. Only approval prompts are recognised as waiting; the harness's other questions to the user are tool calls, which are not read.

`watchSessions` polls every 2 s: it stats the logs of the sessions the last listing found and each project folder (for new sessions), reads only the frames appended since its last look, and fires when a turn opens or closes, an approval is asked for or decided, or a session appears.

## Titles

The harness logs every title as a `session/title` event with its source, and the last one wins:

- `provider`: generated by a model. Shown, as an "ai" title.
- `user`: a rename. Shown, as a "custom" title.
- `fallback`: the leading words of the user's first prompt. **Never read.** Signalbox shows no prompt text, so a session with only a fallback title has no title.

Titles are sanitized like every other one: one line, no control characters, at most 120 characters. A title line over 16 KiB is not parsed.

## Compactions (`readCompactions`)

One event per `compaction/end` without an `error`, for sessions the user started. `trigger` is `manual` when the compaction carries a `sourceCommandId` (a command asked for it) and `auto` otherwise. `preTokens` is the prompt size of the summarizing call, or, when the log has no usage for it, of the last response before it. `compaction/prune` lines (the harness dropping old tool results one at a time) are not compactions and are passed over.

## History (`listHistory`)

One entry per session the user started, with every record of the sessions it delegated. `subagentFiles` counts those sessions, `workflowRuns` the `tool-workflow/run-start` lines. There is **no resume command**: `--resume` belongs to the harness's terminal app, which may not be installed, and the desktop app has no command or link that reopens a session.

## Health

One row, `deepseek-harness:session-logs`: how many logs there are, how many were written in the last 24h, and what the newest one holds (its format generation, its responses with usage, unknown event types, unparseable lines, a damaged frame). It fails when there is a home but no log in it, when the newest log cannot be read, or when its usage lines no longer parse. When there is no harness home at all, the harness is not installed and there is no row: that is not a failing source.

## Not available

- **Plan limits.** The logs hold no limit readings of any provider, so the adapter has no `readLimits`, and the Limits screen shows no card for the harness.
- **Accounts.** Nothing in the logs names one.
- **Command guide.** There is no catalog for the harness yet.

## Other files seen, not used

- `storages/session_projcache/` and `storages/workspace.json`: the harness's own projection cache and workspace list. A cache of the logs, not a source.
- `profiles/`, `dsh-runtimes/`: the app's plugin profiles and bundled runtimes.
- `.anonymous-user-id`, `attachments/`, `cache/`.

## What is likely to break

- The line prefix order. If it changes, lines simply get parsed in full: slower, but still correct.
- A new log generation (`session.v5.jsonl.zstd`). It is read as far as it matches, and health says "in a format newer than v4".
- `assistant/message` or its `usage` renamed. Health reports "usage lines present but none parsed".
- New event types are counted in health as "unknown event types passed over".
- A different frame encoding. Frames the walker does not recognise are not read, and the log shows no new responses.
