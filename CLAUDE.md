# Signalbox

Local control room for AI coding agents: Claude Code first, then Codex and Gemini CLI. It reads what the agents already write on this machine. It needs no credentials and nothing leaves the machine. The plan and its reasoning are in `docs/BRAINSTORM.md`.

## Layout

- `packages/core` — the contract (`src/types.ts`), pricing, aggregation and reconciliation. It has no I/O beyond reading price files.
- `packages/adapter-<agent>` — one adapter per agent, implementing `Adapter` from core. All filesystem reads of agent session and usage data happen here (the command guide's custom command discovery is the one exception, in `apps/cli`).
- `apps/web` — the localhost UI and HTTP server module.
- `apps/cli` — the `signalbox` binary: `report`, `doctor`, `serve`, `watch --ndjson` (the app's stream, protocol v1), `snapshot --json`, `fleet --json`, `commands [--json]` (the command guide), `history [--json] [--no-claude-app]` (past and live sessions merged from transcripts and the Claude app's own session list: the app's title wins; app-only sessions have no stats or resume command; `--no-claude-app` turns the app reader off). It wires the adapters to core and the web server. Custom command discovery (`src/custom-commands.ts`) lives here, not in an adapter, because it covers Gemini CLI too: names and frontmatter descriptions only, never file bodies or settings files. `scripts/build-cli.sh` compiles it to `dist/signalbox`.
- `apps/macos` — the native SwiftUI app (Swift package: `SignalboxKit` with models, transport, store, settings, the notification policy, the command guide's filters and session suggestions, and the History screen's filters, day groups and resume line, plus the `Signalbox` app with the macOS bridges for notifications and launch at login). It runs the bundled CLI in `watch --ndjson` mode. `apps/macos/scripts/build-app.sh` builds `apps/macos/build/Signalbox.app`; `apps/macos/scripts/release.sh` packages it (see `docs/RELEASE.md`).
- `pricing/<provider>.json` — `PriceTable` files with `asOf` and `sourceUrl`.
- `catalog/commands/<agent>.json` — `CommandCatalog` files: every built-in slash command and useful shell command of one agent, what it does, where it works, its side effects and what Signalbox does with it (`signalbox.status`: `view`, `planned`, `no`, `never`). Each is checked against one installed version (`verifiedVersion`), validated strictly by `checkCommandCatalog` in core, and embedded in the binary like the price tables. Describe commands in your own words; never copy vendor docs.
- `packaging/` — `version.sh` (keeps the `package.json` and `bun.lock` copies of `VERSION` in step) and the Homebrew cask template. `VERSION` at the root is the one release version.
- `models/<provider>.json` — `ModelTable` files (context window, max output) with `asOf` and `sourceUrl` per row, embedded in the binary like the price tables. Claude Code-only observations (the `[1m]` suffix, the auto-compact point) are kept separate and marked internal.
- `research/` — throwaway scripts from the research phase. `research/cost/cc_cost.py` is the reference implementation: for the same explicit `--since`/`--until` window, `signalbox report` must match it.

`--days N` means N calendar days everywhere (today since local midnight plus the N-1 days before it); `report --rolling` gives N×24h.

## Commands

- `bun test` (or `bun test packages/core`) to run tests
- `bun run typecheck` to typecheck
- `bun run report -- --days 7`, `bun run doctor` and `bun run serve` to run
- `bun apps/cli/scripts/reference-check.ts --days 7` to confirm cost math still matches `research/cost/cc_cost.py` (run this after any change to pricing, dedup or report code)
- `bun apps/web/src/dev.ts` to see the page with synthetic data
- `cd apps/macos && swift test` for the app tests. `apps/macos/scripts/build-app.sh && open apps/macos/build/Signalbox.app` to build and run it. `Signalbox --render-snapshots <dir> --fixture apps/macos/Fixtures/snapshot.json` renders PNGs of every screen for visual checks, with no Screen Recording permission needed.
- `apps/macos/scripts/click-probe.sh` clicks every sidebar row, a session row, a history row and a command row in a real window (and opens About), by sending in-process mouse events, so no Accessibility permission is needed. It checks the selection changes, and must PASS after any change to navigation or lists. In a `List(selection: Binding<T?>)`, tag rows with `T`, not `T?`: an optional tag silently breaks selection.
- `apps/macos/scripts/notify-dryrun.sh` checks notifications end to end on synthetic sessions, in a copy of the built app with its own bundle id. Anything else that launches the app for testing does the same: `SIGNALBOX_NOTIFY_DRYRUN=1` (stderr lines, never real notifications or the permission prompt), `SIGNALBOX_DEFAULTS_SUITE=<test suite>`, and never a real login item.
- `bun run commands` prints the command guide (`-- --verbose` for details, `-- --json` for what the app reads: catalogs, installed versions, custom commands).
- `apps/macos/scripts/release.sh` packages the app (zip, SHA-256, cask) into `dist/release/`; it refuses a dirty tree unless `--allow-dirty`, and uploads nothing. `packaging/version.sh set X.Y.Z` bumps the version everywhere.
- When the CLI protocol changes, update both sides; `apps/cli/test/stream-fixture.test.ts` guards the stream and the session history (`apps/macos/Fixtures/stream-v1.ndjson`, `apps/macos/Fixtures/history.json`, regenerated with `bun apps/macos/scripts/make-stream-fixture.ts` and `make-history-fixture.ts`) against field drift and `apps/cli/test/commands-fixture.test.ts` guards the command guide (`apps/macos/Fixtures/commands.json`). After editing a catalog, regenerate that fixture: `bun apps/macos/scripts/make-commands-fixture.ts > apps/macos/Fixtures/commands.json`.

## Hard rules

- Never read credential material: `~/.claude/.credentials*`, `*.key` files (including `~/.claude/sessions/*.key` and `~/.claude/daemon/control.key`), `~/.codex/auth.json`, anything under `~/.gemini` with "token" or "oauth" in the name, or the macOS Keychain. Never call undocumented vendor endpoints.
- The Claude app's folder (`~/Library/Application Support/Claude`) also holds its login, cookie and token files. The only thing read there is its session list, through `packages/adapter-claude/src/claude-app.ts`: files under `claude-code-sessions/` (or `$SIGNALBOX_CLAUDE_APP_DIR`) whose relative path matches `^[^/]+/[^/]+/local_[0-9A-Za-z-]+\.json$`, regular files only (lstat; no symlinks), at most 1 MiB, never `archived-sessions.idx`, `scheduled-tasks.json` or `deleted_*`. Keep only the fields in its `KEPT` list and drop the rest right after `JSON.parse` (`postTurnSummary` is a conversation summary). Never write there. Tests use a synthetic folder via `SIGNALBOX_CLAUDE_APP_DIR`; `SIGNALBOX_CLAUDE_APP_TRACE=1` logs every path the reader touches, to audit a real run without printing content.
- Never store or display message content. Parse the usage fields, then drop everything else. The one exception is a session's title: the values of Claude Code's `custom-title`, `ai-title` and `agent-name` transcript lines and Codex `session_index.jsonl` names may be shown, sanitized (one line, no control characters, at most 120 characters). Message bodies, prompts (including `last-prompt` lines), summaries and tool output never. Tests use **synthetic** fixtures only (synthetic titles too); never copy real transcript lines or real titles into the repo.
- Never write to agent config (`~/.claude/settings.json`, `~/.codex/config.toml`, …). Never resume, message or compact a session you did not create. For experiments, use `CLAUDE_CONFIG_DIR` pointed at a temporary directory.
- Missing data is `undefined` ("unknown"), never 0. Unknown models are priced at 0 and listed in `unpricedModels`. Never guess a price.
- Every adapter source declares a `Stability` (`documented` | `preview` | `internal`). Formats change often, so parse defensively: optional fields, and pass through unknown keys and kinds.
- Don't add dependencies without asking. Use Bun built-ins (`Bun.file`, `Bun.serve`, `bun:test`) and `node:` modules.
- The server binds to 127.0.0.1 only. It requires the per-run token in an `Authorization: Bearer` header on every `/api/*` request, accepts only GET, and checks Host and Origin. No CORS, no cookies.

## Style

TypeScript strict, ESM, `.ts` extensions in relative imports. Small pure functions in core. Comments only where the reason isn't obvious.
