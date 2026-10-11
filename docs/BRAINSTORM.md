# Signalbox: brainstorm for a credential-free control room for Claude Code

*Brainstorm · 2026-10-09 · Claude Code 2.1.293 · macOS · subscription plan · desktop Code tab (4 live sessions)*

**Status legend used throughout**

| Tag | Meaning |
|---|---|
| **[V]** | Verified on this machine (2.1.293) |
| **[P]** | Partial: verified only in a headless `claude -p` session, or only the data shape was checked. Desktop behaviour or the real effect was not observed |
| **[D]** | Documented, but not observed here |
| **[?]** | Unverified or unknown. A fallback is listed |
| **[X]** | Tested and refuted, or ruled out on purpose |

> **Do these by hand before starting.** They are side effects of the research runs.
> 1. **Remove `"theme": "dark"`** (and the comma before it) from `~/.claude/settings.json`. A headless `/config theme=dark` probe wrote it there, and the attempt to revert it was blocked.
> 2. **Get rid of the `/heapdump` output. It may contain credentials.**
>    - `~/Desktop/ac19dc5b-…-diagnostics.json`
>    - a 24 MB `.heapsnapshot` in the session scratchpad (`…/scratchpad/verify-control/out/`)
>    - two earlier files a research probe moved to your **Trash** (empty it)
> 3. ✅ *Done:* the research scripts and probe mods were copied into [`research/`](research/). No `*.jsonl` outputs were copied, because they contain your email, account UUID and prompt text. Generated types were not copied either.
> 4. Probe sessions left folders under `~/.claude/projects` with names containing `scratchpad`. Exclude them from your own numbers.
> 5. Your **terminal** `claude` login has expired. The desktop app uses its own login and is fine. Week 1 does not need the terminal login.
> 6. Throwaway `/insights` runs created `~/.claude/usage-data/` (a local HTML report). It is harmless, and you can keep or delete it.

---

## 1. TL;DR

- **Build a local control room that needs no credentials.** It has three parts: a small daemon, a tiny in-session mod, and a page on localhost. Together they see **every** Claude Code session at once, including desktop Code-tab sessions. Working name: **Signalbox**. Don't ship it as "claude-mods": Mods is now an official Claude Code feature, and "claude-" in a product name is a trademark problem.
- **"$ spent / Mtok burned" on its own is a solved, crowded space.** ccusage has 18.9k stars, claude-hud 28.4k and CodexBar 22.3k, and `/usage` already shows API-price dollars for one session. Your edge is four things together: all sessions in one view with desktop included, official plan limits shown with how old each reading is, dollars **reconciled against Claude Code's own cost ledger**, and (in v1) one-click actions.
- **For a third-party tool, the only clean way to run a slash command inside a live desktop session is a mod in that session.** If you post `/compact` to a session's inbox socket, the model just reads it as text. A mod calling `$.command.run` did run `/rename`, `/model haiku` and `/compact` end to end, but only in a headless test. Anthropic's own options are Remote Control and the desktop's session tools, which Claude uses itself. A **Day-0 spike** decides whether mod control works in desktop. It also checks whether a mod can reach the desktop's own `ccd_session_mgmt` tools.
- **One local week of usage:** the estimate came out about **18–29% above recorded** API-equivalent spend (recorded is a lower bound), all on Opus 5.5. **97.7%** of the tokens were cache reads, so only about **2.4% were fresh**. Workflows accounted for about **83%** of the dollars.
- **Week 1 ships a read-only v0.1:** a fleet board and a burn ledger with confidence badges, computed on demand from transcripts, plus the tap-mod spike. Plan gauges follow if the spike passes. **Actions** (compact, model, effort, rename) come in v1 through a second, opt-in mod, with an allowlist, an expiry and an audit log.

---

## 2. What already exists, and the gap

| Space | Leaders (stars, 2026-10-09) | What they do | Why it isn't your tool |
|---|---|---|---|
| Cost reports from transcripts | ccusage 18.9k, codeburn 11.4k, tokscale 5.6k, toknotch, viberank | API-price dollars parsed from JSONL logs | No live state and no official limits. They keep shipping accuracy bugs: ccusage #1710 (dropped Fable rows) and #1837 (2–3x double count), tokscale #1373 (1h cache priced as 5m) and #1386 (missing advisor tokens) |
| Limit monitors and status lines | claude-hud 28.4k, CodexBar 22.3k, ccstatusline 13.2k, Claude-Code-Usage-Monitor 8.7k | 5-hour and weekly bars | Most read the **Keychain login token** and call the undocumented `api.anthropic.com/api/oauth/usage`. claude-hud is clean but works only as a terminal status line |
| Multi-agent tools and remote control | herdr 43k, vibe-kanban 28k (company shut down), opcode 22k (dormant), Happy 24k, CloudCLI 14k, claude-squad, Conductor | Run agents in parallel worktrees, or control them from a phone | Each one owns the terminal, starts its own `claude -p`/SDK process, or proxies the API. **None can see or act on desktop Code-tab sessions** |
| In-session mod dashboards | claude-code-mods, claude-flightdeck, sessiondeck… (all appeared since about Oct 2) | Panes inside a single session | One session, seen from the inside. No view across sessions and no external API. Exception: marveen's *agent-state-observer* mod already writes `$.session.usage()` to a JSON file, which is the same idea as the tap |
| Live-session monitors | claude-view (111★), claude-hud's `externalUsageWritePath` | Hook events over WebSocket plus JSONL backfill / status-line limits exported to a file | Small, or terminal-only. Worth reading claude-hud's file as an extra source of limits |

**What Anthropic already ships (first-party):**
- `/usage` (also `/cost` and `/stats`): a Session block for the current session, plan bars (account-wide), and 24h/7d attribution across this machine's local history.
- `/context`, `/compact`, `/autocompact`, `/insights`.
- The status line receives `rate_limits`, `cost`, `context_window` and `prompt_cache` on stdin. Terminal only.
- `claude agents --json` is the supported way to read session state from outside [V]. It belongs to *agent view*, which is a research preview. The `claude agents` TUI is itself a fleet view with busy, waiting and idle states.
- **Remote Control** runs `/compact`, `/model`, `/effort`, `/usage` and more from the phone or claude.ai. Server mode covers several sessions, and desktop sessions can connect automatically. It has no third-party API, no fleet-wide rules and no history.
- The cross-session inbox socket delivers text only.
- **Mods** (2.1.287, early access): in-session JS/TS that can read usage and run commands.
- Hooks and OTel.
- Analytics dashboards exist only for Team, Enterprise and Console accounts. **There is none for Pro or Max.**
- Inside the desktop app, Claude itself already has cross-session control through the `ccd_session_mgmt` tools: `list_sessions`, `get_usage` (which includes Weekly Fable), `set_session_model`, `set_session_effort`, `set_session_title`, `stop_session` and `clear_session`. External programs can't call them; the desktop docs list "Scripting and automation" as *Not available*. Whether a **mod** can call them through `$.mcp.call` is the open question for the Day-0 spike. **For desktop sessions these tools overlap most of the v1 verbs.** The exceptions are compact and rules across sessions, because there is no compact tool.

**The gap:** no tool combines all of these: credential-free, works with desktop sessions, covers every session at once, and reconciles dollars against Claude Code's own ledger. Each one exists somewhere on its own. The tool would take official limits and cost from Claude Code itself, keep its own history, and act through a small mod rather than through tmux, PTY scraping, proxies or tokens.

---

## 3. Recommended concept

Four competing concepts were designed and scored. Their names are used below:

| Concept | In one line |
|---|---|
| *observer-mvp* | Read-only first cut: fleet board plus burn ledger, shipped in days |
| *ecosystem-native* | One plugin install bundling mod, hooks, MCP and daemon; the repo is also the plugin marketplace |
| *insights-coach* | Analytics-first: waste detectors, limit economics, policy simulator |
| *control-plane* ("Pitwall") | Full remote control of every session from the browser or phone |

Scores out of 10 for feasibility / differentiation / value / safety / effort: observer-mvp 8/6/8/9/9 · ecosystem-native 7/9/9/7/5 · insights-coach 7/8/8/8/5 · control-plane 5/9/8/5/3.

**One direction:** the plugin-plus-daemon shape from *ecosystem-native*, the week-1 read-only phasing and file-spool tap from *observer-mvp*, the analytics from *insights-coach* in v0.2 and v1, and Pitwall's control UX for the later phase.

### Name ideas (none contain Claude, Anthropic or a soundalike)

| Name | Metaphor | npm / brew (checked 2026-10-09) | Notes |
|---|---|---|---|
| **Signalbox** (recommended) | A railway signal box sees every train (session) and throws levers (actions). Its *interlocking* is your allowlist | npm: unscoped `signalbox` **taken**, `signal-box` free, or use your own scope. brew: free. 99 small GitHub repos share the name (largest has 25★) | Gives natural sub-names: **tap** (read) and **levers** (act). Before publishing, run a USPTO/EUIPO search and a GitHub collision check, including against "Signal" messaging marks |
| Taffrail | A ship's taffrail log records distance run, i.e. tokens burned | free / free | Strong fit for analytics, weaker for control |
| Pitwall | The F1 pit wall: telemetry in, radio calls out ("box, box" = compact) | unscoped npm taken (use `@<scope>/pitwall`) / free | Great UX vocabulary |
| Burnboard, Pitboard | Self-explanatory | free / free | Burnboard has about 15 small GitHub namesakes |

**Avoid:** `claude-*`, anything with "mods", Conductor, Dispatch, Agent View, Mission Control, Helmsman (already a brew formula). Precedent: Anthropic asked Clawdbot to rename, and it became Moltbot on 2026-01-27.

**One-liner:** *An unofficial local control room for all your Claude Code sessions, desktop Code tab included. It shows live context and plan limits from Claude Code's own numbers, honest API-equivalent dollars and tokens, and (opt-in) one-click compact, model and effort. No tokens, no Keychain, nothing leaves your Mac.*

**Who it's for:** solo developers on Pro or Max who run 3–8 concurrent sessions, mostly in the desktop Code tab where there is no status line or tmux, and who won't install tools that scrape their login token. The first user runs several sessions in one repo and is workflow-heavy.

**What it borrows from the runners-up:**

| From | Feature |
|---|---|
| observer-mvp | Read-only tap mod that only writes a spool file; "freshest reading wins" across sessions; recorded vs estimated dollars; ships in about 4 days |
| ecosystem-native | Repo doubles as the plugin marketplace; `/sb` in-session command that costs no model turn; MCP tools so Claude can query the fleet; payload-free wake nudges |
| insights-coach | Limit economics, workflow cost explorer, cold-cache and waste detectors, auto-compact dry-run simulator, plugin-tax panel |
| control-plane | `control on --for 8h` expiry; toast in the session for every remote action; "dark" (no mod) sessions shown honestly; "box, box" UX |

---

## 4. Architecture

```
            DATA PLANE (read-only, MVP)                         CONTROL PLANE (v1, opt-in)
┌───────────── Claude Code sessions: desktop Code tab x4 · terminal · background ─────────────┐
│ [signalbox-tap mod]  (~40 LOC)               [signalbox-levers mod]  (separate plugin)        │
│   session.start / session.measure / end        poll queue ──(G1 | G2)──┐                      │
│   snap = $.session.usage()            (A)      optional wake ───(G3)───┤                      │
│   $.fs.write(spool/<sid>.json)        (B)      allowlist + seq/ack check ◄┘                   │
│ [statusLine tee, terminal only]       (C)      $.clock.after(50, $.command.run(...))   (H)    │
│ [settings hooks type:http, v0.2]      (K)      $.ui.log("Signalbox: /compact 14:02")          │
└──────┬─────────────────┬───────────────────┬─────────────────────────────▲────────────────────┘
       │ CC writes       │ mod writes        │ POST                        │ cmd file / UDS / wake
       v                 v                   v                             │
 ~/.claude/projects/**.jsonl     ~/Library/Application Support/signalbox/   │
   (transcripts + cost-state)      spool/<sid>.json (dir 0700)              │
 ~/.claude/sessions/[0-9]*.json    cmd/<sid>.json · levers.sock (0600, v1)  │
   (JSON keys only; NEVER *.key)                                            │
       │ (D)(E)(R)                │ (B')                                    │
       v                          v                                         │
┌──────────────────────── signalboxd (one Bun binary, launchd via brew services) ┴──────────────┐
│ adapters, each tagged documented|preview|internal:                                            │
│   AgentsJson (F) · Registry (R) · TranscriptTailer (D) · CostStateLedger (E) · Spool (B')      │
│   OTLP receiver 127.0.0.1:4318 (L, v0.2) · HookIngest (K, v0.2) · herdr (M, later)              │
│ core: pricing.json · dedup · reconciler · limits "freshest wins" · rules (later)              │
│ store: SQLite WAL (numbers only, never message text) · audit.jsonl (v1)                       │
│ serve: 127.0.0.1:<random> GET + SSE (N) · CLI over UDS · MCP stdio tools (v1)                 │
└──────────────────────────────────────┬────────────────────────────────────────────────────────┘
                                       v
          Browser UI · `signalbox report|doctor` · macOS notifications · SwiftBar (v0.2)
          Phone: link out to Anthropic Remote Control (no relay of our own)
```

### Each arrow, with its exact mechanism and status

| # | Plane | From → to | Mechanism | Status |
|---|---|---|---|---|
| F | data | daemon → session list | Runs `claude agents --json --all` when registry fs.watch fires, plus a 60s safety poll. Each call takes about 0.4s | **[V]** Listed 4 desktop sessions and 1 background session. Works even with the terminal CLI signed out. Badged *preview*, because agent view is a research preview. Caveats: `kind:"interactive"` does **not** mean desktop (headless sessions report it too), and there is no entrypoint field. `claude` here is an nvm symlink, and launchd won't have it on PATH, so `setup` stores the absolute path and re-resolves it when a call fails |
| R | data | daemon → registry | `fs.watch ~/.claude/sessions/[0-9]*.json`, reading keys only (status, statusUpdatedAt, entrypoint, name, version, messagingSocketPath) | **[V]** Keys seen. The registry is only semi-supported, so the UI badges it *internal*. The glob never matches `*.key` |
| D | data | transcripts → SQLite | Tails each file by inode and byte offset, dedups on `message.id`, prices each response | **[V]** Reproduced twice. The JSONL format is documented as *internal* |
| E | data | cost-state rows → ledger | Reads `type:"cost-state"` lines (`totalCostUSD`, per-model `modelUsage`) | **[V]** 52 rows in 32 of 51 main transcripts. Undocumented |
| A | data | tap mod → usage | `$.session.usage()` on `session.measure` (fires after each main-thread turn and on whole-point limit moves) | **[P]** Shape verified in `-p`. `rateLimits` came back `[]` because the CLI was signed out. Desktop **[?]** |
| B / B' | data | tap mod → spool → daemon | `$.fs.write(<abs path>/spool/<sid>.json)` with a `seq` field, picked up by the daemon's fs.watch. `$.fs` has **no rename, remove or append**, and a 4 MiB cap, so a write is not atomic. The daemon retries any spool file that fails to parse, and garbage-collects files for sessions missing from `agents --json` for more than 24h | **[P]** Reported working in the `-p` probe. Desktop **[?]** |
| S | data / control | hub mod → desktop's own tools | `$.mcp.call('ccd_session_mgmt', 'list_sessions' / 'get_usage')`, read-only at first. The types say a plugin's call needs no permission prompt | **[?]** Day-0 spike. If it works, one hub mod gets the fleet view and plan windows (Weekly Fable included), and desktop model, effort and rename need no levers mod. Badged *internal* |
| C | data | statusLine → spool | `signalbox tap sl -- <your old cmd>` copies stdin to the spool and passes it through unchanged | **[P]** stdin JSON and `refreshInterval` verified. `rate_limits` not observed (signed out). Whether a status line runs in desktop at all is **[?]** |
| K | data | settings hooks → daemon | Hooks of `type:"http"` POST SessionStart/End, Pre/PostCompact, Notification, PostModelSwitch, StopFailure | **[D]** Hooks do run in desktop (a third-party SessionStart hook was seen firing there). The http type was not tested. Payloads carry **no** cost |
| L | data | OTel → receiver | OTLP over http/json to 127.0.0.1:4318 | **[P]** `session.count`, `active_time` and events arrived. `api_request` and `cost.usage` were not observed (no auth). Whether user-level env applies in desktop is **[?]**; the desktop docs say managed settings |
| M | data | herdr → daemon | herdr socket `agent.list` and `events.subscribe` | **[D]** Per herdr docs. Not tested |
| G1 | control | levers mod → daemon queue | `$.http.fetch("http://sb/next?s=<sid>", {socketPath})` | **[?]** Declared in the 2.1.293 types, never run. Falls back to G2 |
| G2 | control | levers mod → command file | `$.fs.read(cmd/<sid>.json)` on `$.clock.every(1000–2000)`. The file holds a monotonically increasing `seq`. The mod writes `ack/<sid>.json {lastSeq}` and ignores any seq it has already processed, because it can't delete the file | **[P]** Uses the same fs primitive as B. **The v1 default transport** |
| G3 | control | daemon → session inbox → mod | Daemon posts `SB1 wake <nonce>` (no payload) to `messagingSocketPath`. The mod's `session.receive` returns `{consumed}` and then pulls the real command | **[P]** Consumption from a non-child process verified in `-p`. If the mod is missing or in the middle of a hot reload, the wake reaches the model as a paid turn. **Deferred:** 1–2s file polling is fast enough for compact |
| H | control | mod → slash command | `$.clock.after(50, () => $.command.run({command, args}))`. The timer avoids the "rejects inside an awaited hook" trap | **[P]** `/rename`, `/model haiku` and `/compact` all ran in `-p`, and the model change really took effect. Desktop **[?]** |
| N | n/a | UI ↔ daemon | 127.0.0.1 on a random port. The token arrives in the URL #fragment, and the page strips it with `history.replaceState`. The page sends the token back in an `Authorization` header. The event stream is opened with `fetch()` and parsed from `response.body`, **not** `EventSource`, which can't set headers. Host and Origin pinned. No CORS, no cookies. The token rotates on every daemon start | Design choice |
| — | never | daemon → live session | `claude -p --resume <live id> '/cmd'` | **[X]** Verified to create a second writer on the same `.jsonl` while the live session doesn't change |

---

## 5. Slash commands from outside

**Four hard truths first:**
1. A slash command sent as text (inbox socket, cross-session message, deep link) **never runs**. Only a mod's `$.command.run` inside that session runs it.
2. Typing `/model x` in the interactive TUI **saves your global default** [V, via tmux]. In `-p` the same command is "this session only". Desktop behaviour is [?].
3. Many commands are **interactive-only**: they answer "isn't available in this environment".
4. The desktop app has no scripting of its own, so a session without the mod ("dark") can be observed but not controlled.

| Command | Dashboard affordance | Mechanism | Status | Phase |
|---|---|---|---|---|
| `/usage` · `/cost` · `/stats` | Burn ledger (today / 7d / 30d / lifetime, by model, project and kind) plus 5h/7d plan gauges | Transcripts + cost-state + tap `cost.usd` and `rateLimits`. **Never** parses `/usage` text | Transcript pricing [V]. In `-p`, `/usage` prints only the Session block, no plan bars [V]. rateLimits values [?] | MVP |
| `/context` | Context gauge per session with an auto-compact marker at about 967K (97%) | Tap `context.percent`. Fallback: last main-thread `input + cache_read + cache_creation` ÷ window | Fields [V]. Threshold 967000 [V] via SDK `getContextUsage`. Mod context shape [P] | MVP |
| `/status` | Session card: version, entrypoint, cwd, model, effort, uptime | Registry JSON + transcript `version` / `effort` / `message.model` | `/status` is interactive-only [V]. `$.command.run('status')` returns "no command named /status" [V] | MVP |
| `/list-agents`, agent view | Fleet strip: busy / waiting / idle, time in state, "needs you" lane | `agents --json` + registry watch | [V]. `waitingFor` [D] (nothing was waiting during the test) | MVP |
| *(notify when idle)* | macOS notification on busy→idle and on waiting | Status transitions → `osascript` | [V] source. Sends nothing into any session | MVP |
| `/compact [focus]` | MVP: compaction log (trigger, preTokens). v1: "Box, box" button with a focus field | MVP: `compact_boundary` rows. v1: levers `$.command.run('compact', focus)` | Rows [V]. Dispatch via mod [P] ("Not enough messages" means the real code path ran). `$.session.compact()` **[X] in headless** ("not available … yet"), so it isn't relied on | MVP / v1 |
| *(closed session)* compact | "Compact before resume" on sessions with no live process | `claude -p --resume <id> '/compact'` with the parent's `CLAUDE_CODE_*` env scrubbed, after a liveness check | [P] Reached PreCompact, then failed on auth. Needs your `claude auth login` | Later |
| `/autocompact <N>` | MVP: show window per model. v1: slider labelled **this model, every session** | `$.command.run('autocompact', N)` | Direct in `-p` [P]. Via mod [?]. Persists to `modelSettings` | v1 |
| `/model <x>` | Dropdown per session, with a warning | `$.command.run('model', x)` + snapshot and restore of the `model` key in settings.json | Via mod in `-p` [P]. TUI saves global default [V, via tmux]. Desktop [?] | v1 |
| `/effort <lvl>` | Segmented control, with a warning | `$.command.run('effort', lvl)` | Direct `-p` [P]. Via mod [?]. In the TUI a typed level becomes the model's default for new sessions [D] | v1 |
| `/rename <name>` | Inline title edit | `$.command.run('rename', name)` | [P] via socket + mod, headless only (custom-title row written) | v1 |
| `/recap` | ~~"What's it doing?" drawer~~ blocked | `$.command.run('recap')` | **Blocked via mod** (read from the 2.1.293 binary): /recap runs only for a person typing it (terminal, desktop, claude.ai/code, Remote Control). A mod's command has a plugin origin and gets a refusal. Not offered | — |
| `/color <c>` | Colour chip synced with the card | `$.command.run('color', c)` | Works in `-p` [P] even though it is listed as terminal-only | v1 |
| `/mcp reconnect <s>` | MCP health row with a Reconnect button | `$.command.run('mcp', 'reconnect s')` | No-argument form [V]. Reconnect [D] | v1 |
| `/output-style`, `/advisor`, `/goal` | Settings drawer | `$.command.run(name, arg)` | No-argument forms local in `-p` [P] | v1 |
| `/clear` | Red button, type the session name to confirm | `$.command.run('clear')`. The daemon carries cost forward, because `cost.usd` resets on `/clear` | Local in `-p` [P]. Destructive | Later |
| `/fast` | Hidden unless supported | `$.command.run('fast')` | SDK replies "not available in the Agent SDK" [V]. Interactive [?] | Later |
| `/config k=v` | A few safe toggles only | `$.config.set({key, value})`. Never send `/config` text | Text form in `-p` **wrote your real settings.json** [V, side effect]. `$.config.set` [?] | Later |
| *(free-text prompt)* | "Send instruction" composer, confirmation shows full text and target | `$.prompt.submit({text})`, never `asUser`, so it is labelled as coming from the plugin | [D] types only | Later |
| *(interrupt)* | "Stop turn" | `$.turn.abort({turnId})` from `turn.start`. Background sessions: `claude stop <id>` | [D] | Later |
| *(permission prompt)* | "Needs you" badge only | `status: waiting` + Notification hook | Detection [V]/[D]. **Answering prompts: never** | Never |
| `/loop` pause | Rule: "skip scheduled wakeups near the 5h cap" | Mod consumes `session.receive` with origin `scheduled-trigger` | [?] | Later |
| `/insights` | Link to `~/.claude/usage-data/report.html` if it exists | You run it yourself (it costs a model turn) | [D] | MVP |
| `/background`, `/stop` | Background-agents panel | `claude stop / respawn / logs / rm` | [D]. Background sessions only | Later |
| `/remote-control` | "Open on phone" link | First-party only. No third-party API | [D] | MVP |
| `/plan` `/rewind` `/resume` `/branch` `/fork` `/export` `/permissions` `/hooks` `/memory` `/plugin` `/theme` `/statusline` `/help` | Not offered; shows an "open the session" hint | Interactive-only | [V] "isn't available in this environment" | — |
| `/heapdump`, `/doctor` | Never exposed | — | `/heapdump` wrote a 24 MB snapshot that may contain credentials [V] | Never |

---

## 6. Usage and API-equivalent dollars: the method

**Label every figure "list-price equivalent, not a bill"**, which is how `/usage` itself describes it for subscribers.

### 6.1 Sources, best first. Each figure carries a badge

| Badge | Source | Covers | Caveat |
|---|---|---|---|
| `live` | Tap mod `cost.usd` on `session.measure` | Claude Code's in-memory figure for the running session, including auxiliary Haiku calls and final output | Resets on `/clear` (since 2.1.211). The daemon keeps a running carry: if a value drops, the previous one is added on |
| `ledger` | Transcript `cost-state` rows | Claude Code's own per-model $ and tokens | Written only on exit or resume, with no timestamp |
| `exact` (v0.2) | OTel `api_request` events (`cost_usd`, tokens, `request_id`) | Exact per request | Must be opted in. Strip `user.email`, `account_uuid` and `organization.id` on ingest |
| `transcript` | Per-response pricing (below) | Everything, back to the first transcript | Input and cache are exact. **Output is a lower bound** for subagents and workflows |

### 6.2 Dedup rules
1. Keep only `type=="assistant"` lines that have `message.usage`. Drop `message.model=="<synthetic>"` (a few such lines exist; they are local errors with zero usage).
2. **Key on `message.id`**, falling back to `requestId`. If both are missing, hash (sessionId, agentId, ts, usage tuple) and flag the row `nokey` so a #1837-style double count shows up.
3. Claude Code writes one line per content block: **about 2.1 lines collapse to each response** [V]. Input and cache fields are identical across an id's lines (0 mismatches) [V]. Take the **max** `output_tokens`, and set `output_final` only if some line has a `stop_reason`.
4. No id appeared in more than one file [V], but guard for it anyway.
5. Kind comes from the path: `<sid>.jsonl` is main, `subagents/agent-*.jsonl` is a subagent, `subagents/workflows/wf_*/agent-*.jsonl` is a workflow agent.
6. `iterations[]`: treat `iterations[].model == null` as the top-level model. **Never add iteration usage on top of the top-level usage**; locally they are identical in every response checked [V]. Only when there is more than one iteration, or a different non-null model appears, price each iteration by its own model and flag the row. This guards against the ccusage #1710 class of bug.
7. Content is discarded during parsing and **never stored**.

### 6.3 Per-response formula
```
usd = ( input            * P_in
      + cw_5m            * P_in * 1.25
      + cw_1h            * P_in * 2.00
      + cache_read       * P_read
      + output           * P_out ) / 1e6
      + web_search_requests * 0.01
  × 1.1 if inference_geo is US-only (4.6+ models)
  Haiku 5.5: use the >100K row when input+cache_read+cw_5m+cw_1h > 100,000 for that request
  If the 5m/1h split is missing: main → 1h, subagent/workflow → 5m (matches what was observed)
```
Worked example (Opus 5.5 main turn): in 6, read 180,000, 1h write 4,000, out 900 → (24 + 32,000 + 36,000 + 18,000) / 1e6 = **$0.0860**.

### 6.4 `pricing.json` (USD per MTok, fetched 2026-10-09 from platform.claude.com pricing)

| Model | Input | Output | Cache read | 5m write | 1h write |
|---|---|---|---|---|---|
| Opus 5.5 | 4 | 20 | 0.20 | 5 | 8 |
| Fable 5.1 | 10 | 50 | 0.25 | 12.50 | 20 |
| Fable 5 | 10 | 50 | 1.00 | 12.50 | 20 |
| Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 (incl. `claude-opus-4-5-20251101`, `claude-opus-4-6`) | 5 | 25 | 0.50 | 6.25 | 10 |
| Sonnet 5.5 | 2 | 10 | **0.10 (pricing page) / 0.20 (Claude Code's own ledger)** | 2.50 | 4 |
| Sonnet 5 | 2 | 10 | 0.20 | 2.50 | 4 |
| Sonnet 4.6 | 3 | 15 | 0.30 | 3.75 | 6 |
| Haiku 5.5 ≤100K | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
| Haiku 5.5 >100K | 0.50 | 2.50 | 0.05 | 0.625 | 1 |
| Haiku 4.5 | 1 | 5 | 0.10 | 1.25 | 2 |

- Ship **two price columns**, "platform list" and "as Claude Code prices it". They disagree on Sonnet 5.5 cache reads, and that difference explains part of the observed reconciliation gap.
- An unknown model is priced at $0 with an *unpriced* badge. Never guess.
- Fast-mode rates exist (for example Opus 5.5 at $8/$40). Whether a fast flag appears in transcripts is [?], so default to standard rates and let OTel `speed` decide in v0.2.
- A nightly CI job re-checks the pricing page.

### 6.5 Cache accounting
- Main sessions write the cache at a **1-hour TTL** on a subscription. Current subagents and workflows write at **5 minutes** [V]. Claude Code's own ledger implies exactly 2.000x write pricing for main-only Opus 5.5 sessions [V].
- Hit ratio = read / (read + write + input). **One local week: 97.7%.**
- Saved by caching = read × (P_in − P_read). On Opus 5.5 that is $3.80 per MTok read. In one local week the savings came to about **10× the recorded spend** at list price, and the cache-write premium took back under 1% of them.
- Where the recorded spend went: **cache reads 56%, 5-minute writes 28% (mostly workflow agents), 1-hour writes 7%, output 9%.** On average each request re-read about 212K tokens, so context discipline is the biggest lever.

### 6.6 Recorded vs estimated (reconciliation)
- **Placeholder output:** responses that never get a `stop_reason` line keep the message-start placeholder for output (median 8 tokens). That covers **74% of subagent and 91% of workflow responses** all time, and 98.6% and 94.4% over the last 7 days. Main sessions match the ledger within 1%.
- **Reconciliation:** per session, price the transcript tokens and the ledger tokens **with the same table**, so a price-table disagreement doesn't look like missing data. Then compute coverage k **per model**, never one global k. For Opus 5.5 alone, k ≈ 0.85 (transcript dollars ÷ ledger dollars, over the sessions that have both). Per-session k ranges from 0.53 to 1.00, so per-session estimates are shown as ranges. The rest of the gap is auxiliary Haiku calls (uncached input, about 45% on haiku-4-5 and 55% on haiku-5-5, none in transcripts) and the output placeholders.
- Show **recorded** (the transcript sum, a lower bound) next to **estimated** (ledger where it exists, otherwise transcript ÷ k, and for live sessions the larger of transcript and `cost.usd`). Also show the placeholder share for each session.
- **One local week:** recorded spend drifts by about 1% while sessions write. Workflows were about 83% of it, main sessions about 15% and subagents under 2%. The estimate came out about **18–29% above recorded** (about 19% using the per-model Opus k alone). All of it is Opus 5.5.

### 6.7 Tokens burned
Always show two counters:
- **Total processed** = input + output + cache read + cache write: about **1.88B** this week.
- **Fresh** = input + cache write + output: about **45.5M**.

A single headline of "1.88B burned" is accurate but is 98% cache replay.

### 6.8 Plan limits: what you can legitimately get

| Source | Gives | Where it runs | Status | Use it? |
|---|---|---|---|---|
| Mod `$.session.usage()` / `session.measure` | context, `rateLimits` (five_hour, seven_day, spend_limit), `cost.usd` | Inside each session; documented for terminal and desktop | [P] | **Yes, primary** |
| statusLine stdin `rate_limits` | 5h and 7d used %, resets_at | Terminal only. Appears only after the first response | [D]/[P] | Yes, terminal fallback |
| `claude agents --json` | Status only, no usage | External | [V] | Yes, for the fleet |
| Agent SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` | 5h, 7d and `model_scoped[]` (which would include weekly Fable) | Starts a Claude Code process; needs your CLI login | [P] Callable, but returned "unavailable" because signed out. Experimental, and policy is a grey area | Later, opt-in, off by default |
| `/usage` in `-p` | Session block only | — | [V] | No |
| Desktop `ccd_session_mgmt.get_usage` | Plan, windows including Weekly Fable, context | Claude inside a desktop session [V]. From a mod via `$.mcp.call`: [?] | [V] / [?] | **Day-0 spike.** If it passes, it is the best plan source for desktop. Read-only, badged *internal* |
| Keychain token + `/api/oauth/usage`, claude.ai cookies, guessed token caps | — | — | Forbidden or inaccurate | **Never** |

**Display rules:**
- Limits are account-wide, so the **newest snapshot from any session wins**, keyed on (kind, resetsAt). Show "as of 40s ago, from session *api-refactor*".
- With no tap connected the gauge reads **unknown**, with an "open `/usage`" hint.
- A reading goes grey once its `resets_at` passes.
- Projection uses an EWMA of Δ%/Δt: "weekly reaches 100% around Thu 14:00 at this pace".
- Weekly Fable bucket: not among the documented mod kinds. `SessionRateLimit.kind` is typed as `string`, so record any unknown `kind` verbatim. It is officially reachable only through the experimental SDK `get_usage` (`model_scoped[]`, opt-in), or through the desktop's `get_usage` if the Day-0 `$.mcp.call` spike passes.

**Limit economics (v0.2):** Δ$ and Δtokens summed across all sessions between consecutive whole-point moves ÷ Δ%. That gives "what 1% of my weekly Max buys", as a rolling median. **Confounder:** plan windows also move with claude.ai chat, the mobile app, cloud and web sessions, and other machines, and none of that is visible locally. Label the figure "local $ per point (lower bound)". Drop intervals where % moved but no local tokens were spent, and let the user mark periods of off-machine use.

**Currency:** USD is primary because list prices are in USD. GBP uses a rate you enter, or an opt-in daily ECB rate. "Plan paid for itself N×" = API-equivalent spend ÷ the monthly plan price you enter.

---

## 7. Feature roadmap

### MVP: v0.1 (week 1, read-only, run from source)
Transcripts can be kept for years (`cleanupPeriodDays`), and `cc_cost.py` prices 7 days in about 0.8s. So v0.1 **computes everything on demand from transcripts**, with no database yet.
- **`signalbox report [--days N] [--json]` and `signalbox doctor`.** `report` must match `cc_cost.py` within 0.5% over the same window (`--days N --rolling`, or the pinned `--since`/`--until` window that `apps/cli/scripts/reference-check.ts` uses; plain `--days N` now means calendar days). `doctor` shows the Claude Code version, which adapters are live, stability badges (*documented*, *preview* or *internal*), and the resolved `claude` path. It never runs slash commands.
- **A local page with two views:**
  - **Fleet strip:** one card per session with name, repo, busy/waiting/idle and time in state, model, a context gauge from the transcript fallback, session $ and last activity.
  - **Burn ledger:** today, 7d and 30d by model, project and kind. Total and fresh token counters. Cache-hit ratio. Recorded vs estimated dollars with confidence badges. A reconciliation table comparing transcript and cost-state per session and model.
- **Compaction log** from `compact_boundary` rows (trigger, preTokens).
- **"Needs you" notifications** on waiting and busy→idle, with a per-session mute.
- **The tap-mod spike** (Day 0). If it passes, add plan gauges for 5h and 7d: freshest reading wins, "as of" age, reset countdown, linear projection. If it fails, the gauges read "unknown, open /usage".
- **Security baseline (§9)** and a README section titled "What we will never do".
- Run it with `bun run`, or as a SwiftBar plugin. **No brew formula yet.**

### v0.2 (week 2–3)
- **SQLite store** (numbers only) with an incremental tailer. Run `signalbox-tap` everywhere, plus the statusLine tee for terminal sessions.
- **OTLP receiver** as a proper adapter, giving exact per-request cost and final output. Data collection should already have started on Day 0; see §12.
- HTTP-hooks timeline: compactions, model switches (`PreModelSwitch`/`PostModelSwitch`), rate-limit StopFailures, notifications.
- **Limit economics** ($ and Mtok per 1% of the 5h and weekly windows, a lower bound; see §6.8). Store snapshots from the day the tap works.
- An immediate `/sb` mod command that prints fleet, limits and today's $ inside any session with **no model turn**. Runtime is [?].
- GBP display and the plan-value card. A claude-hud `externalUsageWritePath` adapter.
- Brew formula, your own tap, `brew services` (launchd). `doctor` checks that the launchd agent can read `~/.claude`, because HOME can be on an external volume and macOS privacy rules (TCC) may block it, or the volume may mount late. npm package published with `--provenance`.

### v1 (weeks 3–6)
- **signalbox-levers mod** (a separate plugin) plus an **Actions drawer**: Compact (with focus text), Rename, Model, Effort, Autocompact, Color. (Recap was dropped: Claude Code refuses /recap when a mod sends it.) Runs through `$.command.run`, behind an allowlist, the `control on --for 8h` toggle, confirm dialogs that name side effects, and `audit.jsonl`. Every action also shows up inside the session via `$.ui.log`. If the Day-0 `$.mcp.call` spike passes, desktop model, effort and rename go through the desktop's own `set_session_*` tools instead, and the levers mod keeps only compact and rules.
- **Settings guard:** snapshot `~/.claude/settings.json` before each action, diff it afterwards, and offer a one-click revert. This catches the global default saved by `/model`, the per-model defaults saved by `/effort` and `/autocompact`, and `/advisor`'s saved default. `/output-style` writes the project's `.claude/settings.local.json`, so the guard covers that file too.
- **MCP tools** for Claude inside any session: `fleet_status`, `burn_report`, `limits`. By default they return only the calling session's data plus anonymised fleet totals. Full detail across projects is opt-in per project, so a prompt-injected session in an untrusted repo can't leak your other projects. A `request_action` tool exists but is off by default, and when enabled it only queues an action that you approve.
- **Workflow cost explorer** per `wf_<id>` run and phase, using `.meta.json` and `journal.jsonl`.
- **Plugin-tax panel** from `attributionPlugin`, `attributionSkill` and `attributionMcpServer`. This shows what each installed plugin costs or saves on real data.
- Read-only herdr adapter.

### Later
- **Rules across sessions**, off by default, each with a dry-run simulator that replays history. Examples: compact idle sessions above 85% context; move idle sessions to Sonnet 5.5 when weekly passes X%; toast every session at 5h ≥ 90%.
- Coach nudges and waste detectors: cold-cache resumes, cache busts, failed tool loops, repeated reads.
- Prompt submit and Stop turn, behind a separate permission that is louder than the verbs.
- Cost per commit or PR (labelled ESTIMATED, since several sessions can share a repo).
- SwiftUI menubar app as a signed, notarized cask. Read-only remote view via Tailscale Serve.
- Opt-in SDK experimental meter for the Fable bucket, and "compact before resume" for closed sessions via `claude -p`. Both are **user-invoked only and off by default**. Both run Claude Code processes on your subscription from a third-party tool. The Agent SDK note bars offering claude.ai rate limits in products without approval. Since April 2026, third-party harness usage may be billed as extra usage, and with extra usage off these calls can simply fail.
- Nightly churn-radar CI. Synthetic reconciliation fixtures offered upstream to ccusage and tokscale. Linux support.

---

## 8. Tech stack, repo layout, distribution

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun ≥1.2.17**, `bun build --compile` (darwin-arm64/x64, later Linux), UI embedded | One binary. `bun:sqlite` built in. `Bun.serve` can listen on `unix:` |
| Language | TypeScript strict everywhere | Daemon, CLI, MCP server and both mods share one `protocol` package |
| Schemas | valibot: every field optional, unknown keys passed through, missing means unknown (not 0) | Claude Code shipped 241 releases in 2026, 27 of them in September |
| Store | SQLite WAL: `api_responses`, `session_ledger`, `rate_limit_snapshots`, `context_snapshots`, `compactions`, `daily_rollups`, `audit` | Numbers only |
| UI | Preact + uPlot + SSE. Light and dark CSS tokens. Instrument-panel slate/teal/amber look; **no terracotta or starburst look-alikes** | Small. SSE avoids WebSocket-upgrade risk |
| Mods | Plain ESM function-hook modules (plugin-authoring layout). Types **generated from the installed build**, never vendored | The claude-code repo is "All rights reserved" |
| Pricing | `pricing/2026-10-09.json` with `as_of`, `source_url`, two Sonnet 5.5 columns | Prices change |
| CI | `claude plugin validate --strict`, synthetic fixtures per Claude Code version, Actions pinned to SHAs, a grep that blocks `oauth/usage`, `.credentials` and `find-generic-password` | Keeps the guardrails enforced |
| Licence | Apache-2.0 (its NOTICE carries "Unofficial. Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic PBC.") or MIT | Common in this ecosystem |

```
signalbox/
├─ .claude-plugin/marketplace.json        # repo = plugin marketplace
├─ plugins/
│  ├─ signalbox-tap/                      # MVP: read-only, ~40 LOC
│  │  ├─ .claude-plugin/plugin.json
│  │  └─ hooks/{hooks.json, tap.js}
│  └─ signalbox-levers/                   # v1: opt-in actions
│     ├─ .claude-plugin/plugin.json
│     └─ hooks/{hooks.json, levers.js}
├─ packages/
│  ├─ protocol/                           # valibot schemas shared by mods + daemon
│  └─ core/                               # dedup, pricing, reconcile, limits
├─ apps/
│  ├─ daemon/                             # adapters, store, http/sse, uds, mcp, cli
│  └─ web/                                # Preact + uPlot
├─ pricing/2026-10-09.json
├─ fixtures/2.1.29x/*.jsonl               # synthetic only
├─ SECURITY.md · README.md ("What we will never do") · NOTICE · LICENSE
└─ (separate repo) <owner>/homebrew-tap/Formula/signalbox.rb
```

**Distribution** (`<owner>` and `@<scope>` below stand for the GitHub account and npm scope):
- GitHub Releases, plus a Homebrew **formula** in your own tap: `brew install <owner>/tap/signalbox` and `brew services start signalbox` (launchd). A formula avoids the Gatekeeper and notarization friction that casks have.
- npm `@<scope>/signalbox` published with `--provenance`, so `bunx`/`npx` work.
- Mods via `/plugin marketplace add <owner>/signalbox`, then `/plugin install signalbox-tap@signalbox`. Confirm the exact syntax on your version.
- Dev loop: build mods **inside a throwaway desktop session** with the built-in `plugin-authoring` skill ("Enable for this session" keeps the mod in that session's mods folder). **Never put `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.** That variable is read only from the process env or the *user* settings env, so a dev mod would load into every real session started afterwards. Long-lived desktop sessions also don't hot-reload those folders without `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`.
- No home-made updater; rely on `brew upgrade` or npm.

---

## 9. Security and ToS guardrails

| DO | DON'T |
|---|---|
| Read only documented outputs of the **unmodified** `claude` binary (agents --json, status line, hooks, OTel, mods) plus transcript and registry files for numbers | Read the Keychain, `~/.claude/.credentials*`, `*.key`, `daemon/control.key`, or any OAuth token. The legal page says developers "may not collect, store, or intermediate" these |
| Get limits only from Claude Code itself, and show "unknown" otherwise | Call `api.anthropic.com/api/oauth/usage` or any undocumented endpoint, or scrape claude.ai |
| Keep the tool single-user and local | Offer "Sign in with Claude", relay a subscription to other people, or spoof Claude Code's client or headers (the Usage Policy effective 2026-11-12 forbids misrepresenting the client) |
| Use a Unix socket (0600, peer-uid check) for mod↔daemon traffic. Bind the UI to 127.0.0.1 on a random port, token in the #fragment, exact Host **and** Origin checks (including SSE), custom header, no CORS, no cookies | Bind 0.0.0.0, use wildcard CORS, or ship a default secret. Precedents: CVE-2025-52882, CVE-2025-49596, CVE-2026-31975 (claudecodeui, CVSS 9.8) |
| Ship **read-only**. Control needs `control on --for 8h`, an allowlist of verbs, a `0700` command directory, and an append-only audit log. The threat model is *the browser and other local users*, not same-user code, which could write the command files anyway. Add HMAC only when remote access exists | Auto-answer permission prompts, set `bypassPermissions`, or register a PermissionRequest hook that answers from the UI |
| Send only payload-free wakes to inbox sockets, and only to sessions whose mod heartbeat is fresh | Put command payloads through the inbox socket, or wake a session without the mod (that becomes a paid model turn) |
| Run processes with argv arrays only | Interpolate strings into a shell, or run `$.process.spawn` on daemon input |
| Show aggregates only. Store no message text. Redact secrets in anything displayed. Drop OTel identity fields | Turn on `OTEL_LOG_*` content gates, read `history.jsonl` prompt text, or send any telemetry off the machine |
| Use an isolated `CLAUDE_CONFIG_DIR` for CI and `doctor` probes | Run `/config k=v` or `/heapdump` against the real config in tests (both caused real side effects during the research), or interactive `/model` (it saves your global default) |
| Liveness-check before running `claude -p --resume` on a closed session, and scrub the parent's `CLAUDE_CODE_*` env | Ever run `-p --resume` against a live session (it creates a second writer) |
| For remote access, use Anthropic Remote Control, or Tailscale Serve read-only with a `Tailscale-User-Login` allowlist | Use Tailscale Funnel, trycloudflare quick tunnels or unauthenticated ngrok |
| Keep a plain-text "unofficial dashboard for Claude Code" subtitle plus the disclaimer footer | Use "Claude" in the name, the logo, Claude Code ASCII art or "Official", or vendor Claude Code source, types or anything from the 2.1.88 leak |

---

## 10. Ideas you didn't ask for

1. **"What 1% of my weekly Max buys"**: dollars and Mtok per limit point, by model and project, from official % moves. Shown as a lower bound, because claude.ai and mobile usage move the same windows (§6.8). [P]
2. **Workflow cost explorer**: workflows were about 83% of one local week, and 5-minute cache writes were 28% of dollars. See which `wf_*` runs and phases re-cache the most. [V data]
3. **Plugin tax audit**: per-response cost attributed to each installed plugin via `attributionPlugin` and `attributionSkill`, so a plugin's token-saving claims can be tested on real sessions. [V fields exist]
4. **Cold-cache resume detector**: a gap longer than the TTL followed by a cache-write spike, plus the SessionStart-on-resume fields `estimated_cache_write_usd` and `prompt_cache_likely_expired`. Shows "this resume cost $X; compact first next time". [D]
5. **Auto-compact policy simulator**: replay last week with "compact idle sessions above 55%" and see dollars saved minus compaction and re-cache cost before you turn the rule on. [P]
6. **"Box, box" fleet button**: one click compacts every idle session above N% context, each with an auto-filled focus line (branch plus last task). [P]
7. **MCP tools for Claude itself**: ask any session "which of my sessions is burning most today?". This works like the desktop's own `ccd_session_mgmt`, but for terminal sessions too. [D]
8. **Stream Deck / Raycast / Shortcuts**: `signalbox compact <name>` and `signalbox status --json` give you a physical "compact" key and a menubar ring via SwiftBar without notarizing anything. [design]
9. **Weekly "wrapped" card** (local PNG/SVG): API-equivalent spend, fresh vs cached Mtok, cache savings, "plan paid for itself N×". Project names hidden by default and nothing uploaded. [design]
10. **Model-fit counterfactual**: re-price short, tool-only Opus 5.5 steps on Sonnet 5.5 and show the saving in dollars and in weekly-limit points. [P]
11. **Correctness benchmark for the ecosystem**: publish the synthetic fixtures (placeholder output, missing requestId, null `iterations[].model`, 1h vs 5m writes) as a test suite for ccusage and tokscale. It earns goodwill and contributors. [design]
12. **Churn radar**: nightly CI diffs Claude Code's CHANGELOG and the statusline, hooks, agent-view and mods docs, opens issues, and doubles as a public "what changed for tool builders" digest. [design]
13. **Terminal multiplexers + desktop on one board**: tools like herdr already see terminal panes and Signalbox sees desktop sessions, so merge them into one fleet. [D]
14. **Deep-link launcher**: "New session in repo X with prompt Y" via `claude-cli://open?q=`. It only pre-fills the prompt, shows Claude Code's external-link warning, and never auto-submits. [D]

---

## 11. Decisions only you can make

1. **Name:** Signalbox, Taffrail or Pitwall? Rename the repo away from `claude-mods` before the first public push. A trademark search and a GitHub collision check are still to do.
2. **Actions:** do you want the levers mod in v1 at all, and which verbs? `/model` can change your **global** default and `/autocompact` persists per model, even with the settings guard in place.
3. **Remote access:** none (recommended to start), a read-only phone view over Tailscale Serve, or just link out to Remote Control?
4. **OTel:** OK to add the telemetry env block to `~/.claude/settings.json` for exact per-request cost? Identity fields get stripped. Whether desktop honours user-level env is unverified.
5. **Plan and currency:** which plan tier, and the monthly price to use for the "paid for itself" card. Non-USD currencies from a fixed rate you enter, or an opt-in ECB daily fetch?
6. **Terminal login and openness:** will you re-run `claude auth login` yourself? That unlocks closed-session compact and the optional SDK plan meter later. And should the repo be public from day 1 (Apache-2.0 vs MIT), or private until v0.2?

---

## 12. Week-1 plan

| Day | Goal | Done when |
|---|---|---|
| **Day 0** (about 2–3h) | Do the housekeeping box at the top. Rename the project, then `git init` (`research/` is already in place). **Desktop spike:** open a **new throwaway desktop Code session** in a scratch folder, never an existing one. Turn `research/mods/cm-probe` into a tap there with the built-in `plugin-authoring` skill, so the mod stays in that session's own mods folder. Send one short prompt. **OTel on, if you agree to decision 4:** add the env block to `~/.claude/settings.json` and run `research/otel/otlp_receiver.py`, changed to append JSONL with `user.email`, `account_uuid` and `organization.id` stripped. Check whether events arrive from the throwaway desktop session | Go/no-go table filled in (below). Exact per-request data starts accumulating. Transcripts lose final output for 74–94% of subagent and workflow responses, and that can't be recovered later |
| **Day 1** | `packages/core`: pricing.json, port `cc_cost.py` (dedup, kinds, 1h/5m split, placeholder detection, per-model k). Synthetic fixtures and tests | Tests green on fixtures |
| **Day 2** | cost-state reconciler. Fleet watcher: registry fs.watch on `[0-9]*.json` only, triggering `agents --json`, plus a 60s safety poll. `signalbox report --json` and `doctor` | `report --days 7 --rolling` matches `cc_cost.py --days 7` within 0.5% |
| **Day 3** | Local page: fleet strip, burn ledger, reconciliation table, context gauges, compaction log. Security baseline: 127.0.0.1, fragment token stripped from the URL, `fetch`-streamed events with an `Authorization` header, Host and Origin pins, GET only | You can see your 4 sessions and the week's numbers in a browser |
| **Day 4** | Waiting/idle notifications. If the spike passed: plan gauges from the tap spool, freshest wins, and start keeping rate-limit snapshots. README with the "What we will never do" section, SECURITY.md, NOTICE | `v0.1.0` tagged, run from source (public or private, per decision 6) |
| **Day 5–7** (buffer) | Dogfood. Write the levers design doc. In a throwaway desktop session, repeat the spike for `$.command.run('rename')` and `('model')`, diffing settings.json before and after | Decision on whether desktop control goes into v1 |

**Day-0 go/no-go table**

| Check (new throwaway desktop session only) | Pass → | Fail → |
|---|---|---|
| `session.measure` fires and the spool file appears | Official context and cost per session | Context from the transcript fallback; the dollar and fleet features are unaffected |
| `rateLimits` is non-empty after one prompt | 5h and 7d gauges | Gauge shows "unknown, open /usage". The terminal status-line tee still works |
| `$.mcp.call('ccd_session_mgmt','list_sessions')` and `('get_usage')` from the mod (read-only) | Fleet list, plan windows including Weekly Fable, and context, all from first-party desktop tools with no model turn. Re-scope v1 so desktop model, effort and rename use `set_session_*`, and levers handles only compact and rules | Keep the current design |
| `$.http.fetch` with `socketPath` reaches a test listener | UDS transport becomes an option | File-poll transport (G2), which is the default anyway |
| `$.command.run('rename', …)` from a registered test command works | Levers v1 feasible in desktop | Desktop stays read-only; link to Remote Control for actions |
| `$.command.run('model', …)`, then diff `~/.claude/settings.json` | Note whether the global default changes; the settings guard handles it | Same guard; label `/model` as global in the UI |

*Effort: v0.1 is about 4–5 focused days at the reduced scope above. v0.2 (store, brew, OTel adapter, hooks) about 1–1.5 weeks part-time. v1 levers plus MCP plus explorers about 3–4 weeks part-time. Budget 1–2 h/week while the mods API is early access.*
