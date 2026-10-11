# Signalbox for macOS

A native SwiftUI app (macOS 14+) on top of the `signalbox` CLI, the way BrewUI sits on top of `brew`.
The app never reads agent files itself. It runs the bundled CLI and renders what the CLI streams.

```
SwiftUI views ──▶ SignalboxStore (@MainActor, @Observable) ──▶ CLIProcess ──▶ signalbox watch --ndjson
                        ▲                                          │  stdin: {"cmd":"report","days":N} / {"cmd":"refresh"}
                        └──────────── TransportEvent ◀─────────────┘  stdout: hello / fleet / report / health / commands / history / error lines
```

- `Sources/SignalboxKit`: Codable models that mirror `packages/core/src/types.ts` (decoded leniently), the NDJSON
  protocol, `CLIProcess` (spawns the CLI from an argv array, restarts it with 1s→30s backoff, stops it when the app
  quits), the login-shell PATH lookup, the store, and the formatters.
- `Sources/SignalboxKit` also holds the pure parts of milestone 3: `NotificationPolicy` (which notifications to send),
  `SettingsStore` (UserDefaults-backed settings), `Money` (currency formatting), `PlanValue`, `LaunchAtLoginModel`
  and the notification coordinator. Each sits behind a protocol where it meets macOS, so tests use fakes.
- And the pure parts of milestone 4: the command guide's models (`Commands.swift`, the `signalbox commands --json`
  shape), its filters, search and copy text (`CommandGuide`), the session suggestions (`SessionSuggestions`), the
  sidebar order (`SidebarSection`) and the redraw cadence for relative times (`RefreshCadence`).
- And session history: its models (`History.swift`, the `signalbox history --json` shape and the stream's "history"
  line, Claude app fields included) and the History screen's logic (`HistoryBrowser`: filters, search, day groups,
  the archived and empty-session switches, what a row without a transcript shows, Live pill routing and the
  shell-quoted resume line).
- `Sources/Signalbox`: the app: a `NavigationSplitView` window (Sessions, History, Commands, Usage, Limits, Health; ⌘1…⌘6),
  a `MenuBarExtra`, the Settings window (⌘,), the About window, the Diagnostics sheet (CLI stderr and events), the macOS bridges in
  `App/SystemServices.swift` (UNUserNotificationCenter, SMAppService), and the offscreen snapshot renderer.
- `Resources/AppIcon.icns` and `Resources/AppIcon.icon`: the app icon, drawn by `scripts/make-icon.swift` (see below).
- `Tests/SignalboxKitTests`: Swift Testing. The transport tests drive `Tests/SignalboxKitTests/Fixtures/fake-cli.sh`.
- `Fixtures/`: **synthetic** data only, never anything from a real machine.
  - `snapshot.json`: the `signalbox snapshot --json` shape, generated from `apps/web/src/mock.ts`.
  - `stress-snapshot.json`: the same plus 28 extra sessions, very long names and paths, unknown agents, odd
    limits (no window, over 100%, more than fit in the menu bar) and unpriced models. Use it to check layouts.
  - `stream-v1.ndjson`: one line of each type that the real CLI printed for synthetic agent homes.
  - `commands.json`: the `signalbox commands --json` shape: the real catalogs from `catalog/commands/*.json` plus
    made-up installed versions (Codex newer than its catalog, Gemini CLI not installed) and made-up custom commands.
    Regenerate after a catalog changes: `bun apps/macos/scripts/make-commands-fixture.ts > apps/macos/Fixtures/commands.json`.
  - `history.json`: the `signalbox history --json` shape with made-up titles, projects and figures: about three months
    of sessions, every title source, untitled ones, two projects with the same folder name, a path with a space and a
    quote, a session across midnight, one with no figures, two empty ones (no title, no response), Codex reasoning
    tokens, and live entries for `snapshot.json`'s live sessions. Past desktop sessions are also in a made-up Claude
    app list (the app's title wins, some archived, a raw title label and an effort level), six sessions are only in
    that list (no transcript: no figures, no resume command; two archived; one keeps a Claude Code session id), and
    `sources` counts them. Regenerate with
    `bun apps/macos/scripts/make-history-fixture.ts > apps/macos/Fixtures/history.json`; `bun test` fails when the
    CLI's history has a key path this file lacks.

## Build and open the app

```sh
apps/macos/scripts/build-app.sh          # rebuilds dist/signalbox if its sources, price or model tables, manifests or bun.lock changed, then the app
open apps/macos/build/Signalbox.app
```

The script bundles `dist/signalbox` (built by `scripts/build-cli.sh`) as `Contents/Resources/signalbox` and
signs both ad hoc. `--no-cli` builds the app alone, `--debug` makes a debug build, and `--output DIR` builds
`DIR/Signalbox.app` instead of `apps/macos/build/Signalbox.app`. The bundle version comes from `VERSION` at the repo
root. The app is not notarized: if you copy it to another Mac, Gatekeeper will block it until you right-click ▸ Open
once. `scripts/release.sh` packages a release (zip, SHA-256 and Homebrew cask in `dist/release/`, nothing uploaded);
see [`docs/RELEASE.md`](../../docs/RELEASE.md).

```sh
apps/macos/scripts/build-app.sh --install   # opt-in: also copies the app to ~/Applications/Signalbox.app
open ~/Applications/Signalbox.app
```

`--install` replaces `~/Applications/Signalbox.app` (it refuses while that copy is running) and prints its path.
**Launch at login works best from a stable location** like this one: the build folder is deleted and recreated on
every build, so a login item that points into it can break. Settings ▸ General says so when the app runs from a
build folder.

## Settings (⌘,)

Also reachable from the gear button in the menu bar popover (the only way in when the Dock icon is hidden).

- **General**: Launch at login (`SMAppService.mainApp`; the row shows when macOS wants approval in System Settings ▸
  General ▸ Login Items, with a button that opens it), Show Dock icon, and what the menu bar shows: icon only, the
  highest fresh 5-hour % (the default), the weekly %, or today's recorded spend. With the Dock icon off (menu-bar-only),
  the app starts without a window on macOS 15 and later, so a launch at login stays in the menu bar; the window opens
  from the menu bar item, a notification click, or by opening Signalbox again (on macOS 14 it still opens at launch).
  A window that was open when the app was last killed (not quit) can still be restored by macOS.
- **Notifications**: the permission state with Turn On, Open System Settings and Send Test Notification; one
  toggle per kind; the long-task minutes; the two limit thresholds; quiet-when-viewing; muted sessions.
- **Display**: currency (USD, or GBP/EUR at a rate you enter, with an "as of" date you set) and an optional
  monthly plan price for the plan value tile.
- **Advanced**: a CLI path override (`SIGNALBOX_CLI` in the environment still wins; Apply restarts the CLI),
  **Include the Claude app's session list** (on by default; see History below), Diagnostics, and Reset All Settings
  (launch at login is left alone). Turning the session list off restarts the CLI with `--no-claude-app` (the flag is
  added only when it's off, so a CLI from before it still starts), and History says it's reading until the new list
  arrives.

Settings live in the app's own defaults (`dev.signalbox.app`), written only when you change something.
`SIGNALBOX_DEFAULTS_SUITE=<name>` points the app at another suite, for a test copy that must not touch yours. A
test copy should also get its own bundle id (`scripts/notify-dryrun.sh` does both): AppKit saves window state under
the bundle id, not the suite. Tests and the snapshot renderer keep settings in memory (`InMemorySettings`), so they
leave nothing in `~/Library/Preferences`.

## Notifications

Permission is asked only when you click Turn On (the banner on Sessions, or Settings ▸ Notifications), never at launch.

| Notification | When | Click opens |
| --- | --- | --- |
| "<session> needs you" | A session's status turns to waiting (the body names what it waits for, e.g. "permission prompt", when the CLI says). Once per waiting episode: a session that was already waiting when the app started doesn't count, and one that leaves waiting for less than 30 s and comes back is the same episode. | That session |
| "<session> finished" | A session that was busy for at least N minutes (default 3, from its `statusSince`) turns idle or ends. Ending counts so that a background or SDK run that exits after a long task is reported; it also means stopping a long-running session yourself sends one. | That session |
| "<agent>: <window> at 86%" | A fresh limit reading passes one of your thresholds (default 80% and 95%). Each threshold fires once per window (per `resetsAt`); stale and reset-passed readings never fire; thresholds already passed at app start are only recorded. | Limits |
| "Signalbox can't read data" | Off by default. The CLI has been failing or restarting for 2 minutes. | Diagnostics |

Titles and bodies use the session name or folder name and the agent, never message content. Each session-level
notification has Open and "Mute this session" buttons; a session can also be muted from its inspector or its
right-click menu. A mute lasts for the session's lifetime: the fleet that reports the end is still judged with the
mute in place (so a muted session never says "finished" as it ends), and the mute goes after that, or 10 minutes
after the session disappears. With "quiet when viewing" on (the default), a session's notifications are skipped while the
main window is in front with that session selected.

The rules are in `NotificationPolicy` (pure, unit-tested). The app feeds it each fleet the moment it arrives,
and checks the CLI-failure rule every 5 seconds.

**Fast status.** Notifications are evaluated on every fleet line the moment it arrives; nothing waits for a timer
of its own. The CLI pushes an extra fleet line about half a second after a session status change (its status
pushes: Claude Code's registry folder and Codex's newest rollouts, see `apps/cli/src/watch.ts`), so "needs you"
and "finished" don't wait for the 15 s tick: measured 0.42–0.51 s from the registry write to the notification.
Limit readings arrive with the regular fleet lines, so a threshold notification can take up to 15 s. The app itself
never watches or reads agent folders.

**Dry run.** `SIGNALBOX_NOTIFY_DRYRUN=1` replaces the notification center with one stderr line per notification
and never touches `UNUserNotificationCenter`, so automated runs can't show the permission prompt:

```
notify kind=waiting target=session:claude-code/2b9e0f14-… title=docs sweep needs you
notify kind=limit target=limits title=Claude Code: 5-hour at 86%
```

Outside an app bundle (`swift run`) notifications are unavailable (Settings says so); build the app to use them.

**Click check.** `scripts/click-probe.sh` launches a copy of the built app with its own bundle id, throwaway settings and log-only notifications. The copy clicks each sidebar row, then a session row, then (on History, once the first history line is in, up to 30 s) a history row near its leading edge, away from the Live pill, then (on Commands) a command row by sending its own window real mouse events, which needs no Accessibility permission. When the window can't become key (another app keeps focus, or the screen is locked) the same events go straight to the lists. It prints `PASS` when every click changed the selection (sessions, history and commands may be "skipped" when there are none, or the CLI doesn't send them). Run it after touching navigation or any `List(selection:)`. Rows must be tagged with the selection's non-optional type: `.tag(section)`, never `.tag(section as SidebarSection?)`, or clicks silently do nothing. `click-probe.sh --no-build path/to/Signalbox.app` probes another build; `FIXTURE=apps/macos/Fixtures/snapshot.json` runs it on the synthetic fixtures (history and command guide included) instead of the CLI.

**End-to-end check.** `scripts/notify-dryrun.sh` runs a copy of the built app against synthetic sessions and checks
the dry-run lines: busy → waiting gives one "needs you" within 1.5 s, waiting → busy → waiting within 30 s gives no
second one, 10 minutes busy → idle gives "finished", and a short busy stint gives nothing. It never touches your
sessions, settings, login items or notification permission:

```sh
apps/macos/scripts/build-app.sh
apps/macos/scripts/notify-dryrun.sh            # or: notify-dryrun.sh path/to/Signalbox.app; KEEP=1 keeps the log
```

The copy gets its own bundle id and runs with an empty `HOME`, `CODEX_HOME` and settings suite, a fake
`CLAUDE_CONFIG_DIR` whose registry rows point at `sleep` stand-ins, and a fake `claude` for `agents --json`. Its
window opens for about 15 seconds. The script stops only the processes it started, checks that the bundled CLI
exited with the app, and removes the copy's defaults.

## Currency and plan value

Every money figure, chart axis included, goes through one formatter (`Money`). USD is the default and unchanged.
GBP and EUR are converted from the USD list-price figures at the rate you enter in Settings ▸ Display; wherever
totals appear the app says "converted at your rate" (the Usage page shows the rate and its "as of" date). Without a
rate, figures stay in USD. Signalbox never fetches exchange rates.

With a monthly plan price set, Usage shows a **plan value** tile: "Last 30 days at list price ≈ 4.2× your
$200/month plan", from the recorded (lower-bound) spend of a 30-day report. On Today or 7 days the tile says it
needs the 30-day range, with a "Switch to 30 days" link, instead of prorating (the plan price is in its tooltip). A plan priced in another currency needs that currency's rate.

## What the screens show

- **History** lists every session the CLI found a transcript for, past and live, and the sessions in the Claude app's
  own session list, newest activity first, grouped by day like the app's list: Today, Yesterday, the weekday for the
  rest of the last week, then one group per month. Each row shows the session's title (the Claude app's, for a
  session it lists; else as the transcript has it: set with /rename or written by the Claude app, else generated by
  Claude Code, else an agent name; Codex session names; "Untitled session" otherwise), the agent, the project folder,
  when it started, the main model, how long it ran and its recorded cost. Titles and stats only: the CLI never
  sends prompts, replies or tool output, and the app shows a title on one line, without control characters, at most
  120 characters. Search (in the toolbar) matches titles and project folder names (and a pasted session id); filter
  by agent, project and range (7 days, 30 days, All; calendar days by last activity). Sessions opened and closed with
  nothing sent (no title and no response, not running) are hidden behind "Show N empty sessions" in the filter bar; a
  pasted session id still finds one. A "Live" pill marks a session
  that runs now (the fleet decides, as it's fresher than the history); clicking it opens the session on Sessions.
  Sessions archived in the Claude app are hidden, as the app hides them, behind "Show archived (N)" beside "Show N
  empty sessions" (a running session stays listed whatever the app says, and a pasted session id or Claude app id
  still finds one); shown, they carry an "Archived" badge. A session the app lists whose Claude Code transcript isn't
  on this Mac (removed, or created on another machine) shows its title, folder and dates, a dash for the cost and
  "No transcript" where the duration goes, never $0.00, and adds nothing to the totals.
  The inspector says where the title came from ("From the Claude app", "(generated)" when the app made it up), the
  project (Reveal in Finder), branch, times, entrypoint and version, models (and the effort the app set), recorded
  cost and Claude Code's own figure when there is one, fresh and processed tokens, compactions, subagents and
  workflow runs, for a session in the app's list whether it's archived there and the app's id, and a **Resume** box:
  `cd '<project>' && claude --resume <id>` (or `codex resume <id>`), the directory single-quoted for the shell, with
  Copy (⌘C on a selected row copies it too). When the project folder no longer exists, the line leaves out the `cd`
  (it would fail and stop the command) and the box says so. For a session without a transcript the inspector
  explains instead: "This session is in the Claude app's list, but its Claude Code transcript isn't on this Mac
  (removed or created elsewhere), so there's no usage or resume command." **Signalbox never resumes a session
  itself.** The CLI sends the history after its first transcript scan, then every 5 minutes and a few seconds after a
  session starts or ends; a CLI that hasn't sent one 2 minutes after connecting shows "Update the CLI". The window
  subtitle counts what the list shows ("52 of 59 sessions" while filters or hidden empty and archived sessions
  narrow it).
  **The Claude app's list.** The CLI reads the app's per-session records (`~/Library/Application Support/Claude/
  claude-code-sessions/*/*/local_<id>.json`, regular files of at most 1 MiB, nothing else in that folder)
  read-only, keeps the title, folder, dates, ids, model, effort and archived flag, and drops everything else as soon as
  a file is parsed. The format is internal to the app (Health shows it as `claude-app:sessions`, internal). A session
  in both lists is one entry: the app's title, the transcript's figures and duration (first to last transcript line),
  and the earliest start and the latest activity for ordering. Turn it off in Settings ▸ Advanced; the list is then
  what the transcripts hold, with their titles. Quick toggles queue: the CLI restarts one at a time and ends on the
  last setting. Without the Claude app, Health shows a note rather than a warning; with `CLAUDE_CONFIG_DIR` pointing
  away from `~/.claude` the CLI leaves the app's list out and History's note says why. See the root README's
  "Session history".
- **Commands** is a guide to every built-in slash command and useful shell command of Claude Code, Codex and Gemini
  CLI (from `catalog/commands/*.json`, embedded in the CLI and sent on the stream's `commands` line), plus your own
  commands, skills and plugin commands (names and descriptions only; the CLI never sends their contents). Search
  (in the toolbar) matches names, aliases and descriptions; filter by agent (each shows its installed version or
  "not installed"), category, and what Signalbox does with a command: **Shown in Signalbox** (a link to the screen
  that shows it), **Planned** (may be run from here later, for Claude Code only, through an opt-in mod after the
  desktop app test), **Run it in the session**, or **Not offered** (destructive or sensitive). A row's tags say where
  it works (terminal, desktop app, headless `-p`, Remote Control; amber means in part). The inspector has the details,
  side effects in amber, where it works and doesn't, the Signalbox note, how and on which version the entry was
  checked, and the source page. **Signalbox runs no commands**: Copy (or ⌘C on a selected row) puts the command on the
  clipboard to run in the session. With more than a handful of your own commands, "Your commands" shows six until
  you ask for all; long plugin names are cut in the middle with the plugin lead dimmed, so the end that tells them
  apart stays visible. Codex custom prompts (`~/.codex/prompts`) are tagged "Legacy prompt" and "Not loaded by Codex
  CLI" instead of "Run it in the session": Codex deprecated them for skills, and recent Codex CLI releases don't load
  them (they show only under the Any filter). A CLI from before the command guide shows "Update the CLI" after 20 s of silence.
- **Suggested** (the session inspector) offers copyable commands for the session's state, only from that agent's
  catalog: context at 75% or more suggests compacting ("≈780K of 1M"), a session idle for 30 minutes with half its
  context in use suggests compacting or starting fresh, and a session waiting at a prompt says to answer it in the
  session (Signalbox never answers prompts); a compact suggestion beside it says to answer the prompt first, as one for a
  busy session says to wait for the turn. Codex gets Codex's commands and Gemini CLI `/compress`.
- **About Signalbox** (app menu) shows the app version, the CLI version and protocol from the CLI's hello, the
  versions the command guide was checked against, and links to the docs.

- **Ranges are calendar days**, as in the CLI report and the web page: "Today" is since local midnight, "7 days" is
  today and the six days before it. The Usage header and the menu bar's dollar figure both name the exact span
  ("7 days · 3 – 9 Oct").
- **Usage chart** (Swift Charts): spend per day from `report.byDay`, stacked by model, kind or token type (cache
  reads, cache writes 5m/1h, output, input, web search). Days with no usage are zero bars. Hovering a day shows its
  total and split. Colours follow the series, not its rank: a model keeps its colour for the life of the app
  (`SeriesSlots`, the first seven models; later ones chart as grey "Other"), and the model and kind tables show
  the same swatches. A Today report is one bar with a note (the report has no hourly split). On 30 days about every
  fifth day is labelled, today always (right-aligned under the last bar). VoiceOver gets an
  audio graph and data table through `accessibilityChartDescriptor`. The menu bar popover shows a sparkline of
  spend per day under the dollar figure when the window has more than one day.
- **Estimated** shows one figure when the low and high ends round to the same dollars, with "Corrected for missing
  output" (or "Equals recorded: no ledger to calibrate against" when it is the recorded figure).
- **Context bars** fill by the window percent: teal, amber from 75%, red from 90% or 5 points before
  auto-compaction (whichever comes first), with a tick where auto-compaction starts ("auto-compact at 97%") and
  "319K of 1M (32%)". No known window means an empty track, never 0%. `windowSource` (newer CLIs) says whether
  the window came from the agent or from the model's documented size; the inspector shows it.
- **Limits** fill only when the reading is current. A reading older than 15 minutes, or one whose window has
  reset since, shows an empty grey bar or ring labelled "stale · as of 8d ago" or "reset passed", with the last
  value as "was 88%". The menu bar's percentage uses fresh 5-hour readings only.

## Develop

```sh
cd apps/macos
swift build
# Run against the CLI sources (no compile step): bun runs apps/cli/src/main.ts watch --ndjson
SIGNALBOX_CLI="bun:$(cd ../cli/src && pwd)/main.ts" swift run Signalbox
# ...or against a built binary
SIGNALBOX_CLI="$(cd ../.. && pwd)/dist/signalbox" swift run Signalbox
# ...or with no CLI at all, from a saved snapshot (the `signalbox snapshot --json` shape)
swift run Signalbox --fixture Fixtures/snapshot.json
```

The app looks for the CLI in this order:

1. `SIGNALBOX_CLI`, set to a binary path or to `bun:/abs/path/main.ts`.
2. The CLI path in Settings ▸ Advanced (same two forms). "Now running" there names where the running CLI came
   from: bundled, `SIGNALBOX_CLI` (binary or bun script) or Settings (binary or bun script).
3. `Signalbox.app/Contents/Resources/signalbox`.
4. If none exists, the app shows a "CLI not found" state. An explicit choice (1 or 2) that doesn't work is reported,
   not skipped.

The CLI's PATH is your login shell's PATH (your account's shell, e.g. `zsh -l -i -c`, run once with a 4s timeout;
fish is asked with `string join : $PATH`, and csh-style shells through zsh) plus `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` and `~/.bun/bin`. The CLI also has its own fallbacks for finding `claude`,
`codex` and `gemini` (see the root README), so a Finder launch with a bare PATH still sees your sessions.

`SIGNALBOX_DEBUG=1` makes the app print one line per stream event to stderr. The app's own lines carry counts,
timings and statuses only (no session names, paths or line content). The CLI inherits the variable and adds its
per-tick timings; its stderr and error lines are forwarded as written, prefixed `cli:`, and can contain file paths.
`0`, `false`, `no`, `off` and an empty value mean off, in the app and the CLI alike. The fleet line ends with how many
sessions have a context reading and how many of those came with a window (`contexts=4 windowed=4`), so a bar that
doesn't fill can be told apart from a session with no reading. A `state …` line follows
every change of what the window shows (`starting`, `connected`, `restarting attempt=N`, `failed attempt=N`).

```sh
SIGNALBOX_DEBUG=1 build/Signalbox.app/Contents/MacOS/Signalbox
# signalbox-app: started pid=5917 args=watch --ndjson --days 7
# signalbox-app: hello v=1 version=0.1.0 pid=5917
# signalbox-app: state connected
# signalbox-app: fleet sessions=5 [busy=1,idle=3,ended=1] agents=[claude-code] limits=3 compactions=0 health=8 contexts=4 windowed=4
open --env SIGNALBOX_DEBUG=1 --stderr /tmp/signalbox.log build/Signalbox.app   # the same, launched like Finder does
```

**Diagnostics** (Help ▸ Signalbox Diagnostics, ⌥⌘D, or click the connection line at the bottom of the sidebar)
shows the CLI command, its PID, how it last exited, the PATH it got, and its stderr.

## Test

```sh
cd apps/macos
swift test
# Opt-in: also run the real CLI against this machine's data (prints counts only)
SIGNALBOX_INTEGRATION_CLI="$(cd ../.. && pwd)/dist/signalbox" swift test --filter Integration
# Opt-in: notifications end to end on synthetic sessions, in dry-run mode (opens a test copy's window; see Notifications)
scripts/notify-dryrun.sh
# Opt-in: check that decoding loses no field of a stream, snapshot, command guide or history captured here (prints key paths, no values)
../../dist/signalbox snapshot --json > /tmp/snap.json      # or: watch --ndjson > /tmp/stream.ndjson, commands --json > /tmp/commands.json, history --json > /tmp/history.json
SIGNALBOX_STREAM_CAPTURE=/tmp/snap.json swift test --filter Contract
```

The contract tests decode each fixture, encode it again and compare every key path with the raw JSON, so a
renamed field or a row the lenient decoder skipped fails the test instead of turning into a silent "unknown".
On the CLI side, `apps/cli/test/stream-fixture.test.ts` (run by `bun test`) fails when the CLI starts sending a
key path that `Fixtures/stream-v1.ndjson` doesn't have, or when the stream's history line has one that
`Fixtures/history.json` doesn't. Then regenerate the fixture and run `swift test`. The synthetic
session runs `claude-opus-5-5` with a 1M window from the tap spool, so the fixture carries `windowSource` and
`autoCompactAtPercent` too, and its transcript has a generated title and then one set with /rename, a git branch and
entrypoint, and a cost-state row (Claude Code's own figure, for the report's reconciliation and the history's
`ledgerUsd`). A synthetic Claude app session list (`SIGNALBOX_CLAUDE_APP_DIR`) holds a record for that session with
its own title (which wins over both transcript titles), one for a session with no transcript and an archived one;
each record also carries fields the CLI must drop (a summary, a prompt suggestion), and a test checks they never
reach the stream. The script waits for the history line, which follows the first fleet and report:

```sh
bun apps/macos/scripts/make-stream-fixture.ts > apps/macos/Fixtures/stream-v1.ndjson
```

The command guide has its own guard: `apps/cli/test/commands-fixture.test.ts` runs the real `signalbox commands
--json` on synthetic homes holding every kind and scope of custom command for all three agents, and fails when it
sends a key path, a custom kind or a scope that `Fixtures/commands.json` lacks, or when the fixture's catalogs are
older than `catalog/commands/*.json`. On this side, `theFixtureUsesOnlyValuesTheAppKnows` fails when the fixture
carries a category, status, view, surface, check method, kind or scope the app has no name for. Regenerate with
`bun apps/macos/scripts/make-commands-fixture.ts > apps/macos/Fixtures/commands.json`, then `swift test`.

## Snapshots (checking the layout without screen recording)

```sh
cd apps/macos
swift run Signalbox --render-snapshots /tmp/signalbox-shots --fixture Fixtures/snapshot.json
swift run Signalbox --render-snapshots /tmp/signalbox-stress --fixture Fixtures/stress-snapshot.json
# Your own data (keep the output out of the repo):
../../dist/signalbox snapshot --json > /tmp/real.json
swift run Signalbox --render-snapshots /tmp/signalbox-real --fixture /tmp/real.json
```

This renders Sessions (with a session selected), History (every session), Commands (with `/compact` selected), Usage,
Limits, Health and the menu bar popover, in light and dark, at 1280×820 (the popover 360 wide, at its natural height). It also renders each Settings pane in light and
dark (`settings-*`), the Sessions notification banner (`sessions-banner-*`), the plan value tile (`usage-plan-30d-*`,
and `usage-plan-7d-*` asking for 30 days, drawn as connected to a CLI so its switch link shows) and GBP at a user
rate (`usage-gbp-*`, `sessions-gbp-*`, `menubar-gbp`). Each render uses a
in-memory settings and fake notification and login-item services; nothing touches any defaults domain. The menu bar
item itself comes as a strip of every label mode, today's spend in GBP, a waiting session and the CLI down
(`menubar-labels-*`, drawn at 2× so the gauge symbols can be told apart).
`SIGNALBOX_RENDER_ONLY=settings,menubar` renders only the shots whose names start with those prefixes. Usage also comes as whole-page "tall" shots
(by model, by project, the chart by kind and by token type), with the hover callout pinned to a day
(`usage-hover-*`), and for Today and 30 days (`usage-today`, `usage-30d`, `menubar-30d`, `menubar-today`). It also
renders the CLI-missing and empty states, the Diagnostics sheet for a CLI that keeps failing (`diagnostics-light`) and
the whole session inspector on its own (`sessions-inspector-*`).

Milestone 4 adds the Commands screen for all agents (`commands-all-*`), one agent whose installed version differs
from its catalog (`commands-codex-*`), your commands with a project one selected (`commands-custom-*`), Claude Code's
context commands (`commands-selected-*`), an agent that isn't installed (`commands-gemini`), a search across agents
(`commands-search`), searches with no results (`commands-search-empty*`), the "Shown in Signalbox" filter
(`commands-shown`), a CLI too old to send the guide (`commands-cli-too-old`) and a snapshot without one
(`commands-no-guide`); session suggestions (`sessions-suggest-*`: compact at 90%, a permission prompt, and a Codex
session idle for two hours); and the About window (`about-*`). The guide comes from `--fixture-commands <file>`, or
from a `commands.json` beside the fixture (so `Fixtures/snapshot.json` picks up `Fixtures/commands.json`), or from
the snapshot itself (`signalbox snapshot --json` includes it). `swift run Signalbox --fixture …` loads it the same way.

History adds the Claude app's list: archived sessions shown (`history-show-archived-*`), a session only in the app's
list selected (`history-selected-app-only-*`, its whole inspector in `history-inspector-app-only-light`), an archived
session with a transcript (`history-selected-archived`), a search that only archived sessions match
(`history-search-archived`) and the list turned off (`history-claude-app-off`); Settings ▸
Advanced has the switch (`settings-advanced-*`) and Health its row. It also adds one agent (`history-codex-*`), a search (`history-search-*`), a selected entry with the inspector
(`history-selected-*`, the whole inspector on its own in `history-inspector-*`, a path that needs quoting in
`history-selected-quoted`, an untitled entry with no figures in `history-selected-untitled`, a session whose project
folder is gone in `history-selected-folder-gone`), a project over 30 days
(`history-project-30d`), empty sessions shown (`history-show-empty`), the smallest window with the inspector open
(`history-narrow`), GBP (`history-gbp`), no
sessions (`history-empty-*`), a search with no results, waiting for the first scan (`history-loading`), a CLI too old
to send one (`history-cli-too-old`) and a snapshot without one (`history-no-history`). The history comes from
`--fixture-history <file>`, or a `history.json` beside the fixture (so `Fixtures/snapshot.json` picks up
`Fixtures/history.json`), or the snapshot itself (`signalbox snapshot --json` includes it); `swift run Signalbox
--fixture …` loads it the same way. Offscreen, a bordered pop-up button in the filter row sometimes isn't captured in
light mode; the project menu is a borderless one, which is.

The Today and 30-day shots come from `--fixture-today` and `--fixture-30d` when given (snapshots taken with
`--days 1` and `--days 30`); otherwise they are scaled copies of the main fixture's days, made by
`Rendering/SyntheticReports.swift`, so their numbers only roughly agree with each other.

```sh
../../dist/signalbox snapshot --json --days 1 > /tmp/real-1d.json
../../dist/signalbox snapshot --json --days 30 > /tmp/real-30d.json
swift run Signalbox --render-snapshots /tmp/signalbox-real --fixture /tmp/real.json \
  --fixture-today /tmp/real-1d.json --fixture-30d /tmp/real-30d.json
```

### Redacted shots (the README's)

`--redact` renders every scene under `.redacted(reason: .privacy)`, so whatever the app marks `.privacySensitive()`
comes out as placeholder bars: session and history titles, project names and paths (working directory, transcript,
resume command, Usage's by-project rows), session and Claude app ids, git branches, your own commands (names,
descriptions, sources, projects), waiting sessions in the popover, the CLI path, PATH and stderr. Built-in command
names, models, numbers and charts stay readable. The same marks let macOS hide that text where it redacts
privacy-sensitive content. The screenshots in `docs/screenshots/` are redacted renders of the synthetic fixtures,
never of real data:

```sh
swift run -c release Signalbox --render-snapshots /tmp/signalbox-redacted --fixture Fixtures/snapshot.json \
  --fixture-commands Fixtures/commands.json --fixture-history Fixtures/history.json --redact
```

They are `sessions`, `history-selected` (as `history`), `usage`, `commands-selected` (as `commands`), `limits` and
`menubar`, light and dark. Pick shots with an empty search field: the toolbar's search field is AppKit's and isn't
redacted (offscreen, it draws no text either).

The renderer uses an offscreen `NSWindow` with `NSHostingView` and `cacheDisplay`.

macOS 26 draws Liquid Glass and scroll-edge effects with backdrop layers, which can't be captured offscreen. So the
renderer hides the scroll-edge pockets and draws each glass panel (the sidebar, the inspector, toolbar platters)
as a flat panel with the real content on top. The glass in the PNGs is an approximation, and everything else is
real rendering. The PNG paths are printed on stdout.

To regenerate the snapshot fixtures:

```sh
TZ=UTC bun apps/macos/scripts/make-fixture.ts > apps/macos/Fixtures/snapshot.json
TZ=UTC bun apps/macos/scripts/make-fixture.ts --stress > apps/macos/Fixtures/stress-snapshot.json
```

## App icon

A railway semaphore signal (teal arm raised to "clear", amber lamp at the pivot) on a slate rounded square, drawn
with Core Graphics at every size. Sizes of 32 px and below get a simplified, heavier drawing so the signal still
reads in lists. Regenerate after changing the drawing:

```sh
swift apps/macos/scripts/make-icon.swift                      # writes Resources/AppIcon.iconset (ignored), Resources/AppIcon.icns and Resources/AppIcon.icon
swift apps/macos/scripts/make-icon.swift --preview /tmp/icon  # also 1024/64/32/16 px PNGs, magnified copies and a contact sheet
```

`Resources/AppIcon.icon` is the same drawing in Icon Composer's format for macOS 26: a slate fill (the system's
automatic gradient) with two layers, the ground line and the signal, edge to edge on a 1024 canvas, so the system
applies the rounded-square mask, the shadow and Liquid Glass itself. `build-app.sh` compiles it with
`xcrun actool` into `Contents/Resources/Assets.car` and sets `CFBundleIconName`; it still copies `AppIcon.icns` and
sets `CFBundleIconFile` as the fallback (if actool fails, the build says so and uses the `.icns` alone). The
`.icns` alone is shown on a light plate at 32 px and below on macOS 26.

## Troubleshooting

Open Diagnostics first (⌥⌘D). It shows the CLI command and PID, how the CLI last exited, the PATH it got, and its
stderr.

- **"Signalbox CLI Not Found"**: the app was built with `--no-cli`, or `dist/signalbox` didn't exist. Run
  `apps/macos/scripts/build-app.sh` again, or set `SIGNALBOX_CLI`. A `SIGNALBOX_CLI` that points at something
  missing is reported as such, not skipped.
- **No sessions, but `claude` is running**: run `dist/signalbox doctor` from a terminal. It says where it found
  `claude` (or that it didn't). Set `SIGNALBOX_CLAUDE_BIN=/path/to/claude` if it's somewhere unusual. Diagnostics
  shows whether the login-shell PATH resolved; a shell startup file that waits for input makes it time out after 4s.
- **"Restarting in …"**: the CLI exited. The window (and the menu bar popover) says how, with its last stderr line,
  and Diagnostics has the rest. The app retries with backoff (1s, 2s, 4s, … up to 30s). While the CLI is down the
  menu bar shows a disconnected symbol instead of a percentage.
- **"The CLI Couldn't Start"**: the CLI couldn't be run at all, or exited three times in a row before sending
  anything (a removed or unexecutable binary, an older CLI without `watch`, a bad `SIGNALBOX_PRICING_DIR`). The app
  keeps retrying every 30s and recovers by itself once a run connects. Run the same command by hand to see the
  whole error: `…/Contents/Resources/signalbox watch --ndjson`.
- **Today / 7 days / 30 days is greyed out**: the app is showing a `--fixture` snapshot, so there's no CLI to ask
  for another window.
- **Claude Code limits say "unknown"**: that's expected without the signalbox-tap mod (see `docs/SPIKE.md`).
- **A `signalbox` process left over**: shouldn't happen. The CLI exits when the app quits (SIGTERM), when the
  app is killed (its stdin closes), and when nothing reads its output. `pgrep -fl "signalbox watch"` finds one.
- **No notifications**: Settings ▸ Notifications shows the permission. "Off in System Settings" means macOS has
  them turned off for Signalbox (Open System Settings). "Unavailable" means the app isn't running from a bundle.
  Check that the kind is on and the session isn't muted, and Send Test Notification.
- **Launch at login "requires approval"**: open System Settings ▸ General ▸ Login Items (the button in Settings
  does) and allow Signalbox. If the app lives in a build folder, install it with `build-app.sh --install` first.

## Notes

- Relative times ("active 12s ago", "Busy · 4m", "resets in 2h") redraw every second only while a time on screen is
  under a minute old, and every 30 s otherwise (`RefreshCadence`); each session row has its own clock, so a quiet
  list doesn't redraw every second. Measured on the synthetic fixture with the Sessions screen showing: 0.95–1.08% CPU
  at idle before, 0.08% after. Against this Mac's real sessions (a bundle copy with its CLI, 60 s after a 20 s
  settle, Sessions showing), the app averaged 0.35–0.47% and its CLI 0.70%, down from about 0.8–1.6% for the app
  in milestone 3.

- With every agent showing, the Commands list has a few hundred rows, and macOS 26 logs "Application performed a
  reentrant operation in its NSTableView delegate" once when it opens. A plain SwiftUI `List` of that many `Text`
  rows logs the same (it stops below roughly 200 rows), so it comes from the framework, not from these views; it
  has no visible effect.

- The CLI that the app runs keeps each Claude Code transcript's parsed usage while the file's size and mtime stay
  the same, so its 60s report tick re-reads only the transcripts that grew. Measured on a busy machine: 250–350 MB
  while the first scan runs, then 30–90 MB, with brief peaks of 120–150 MB on report ticks while sessions are active
  (before this, every tick went back to 350–500 MB).

- Every money figure is a list-price equivalent, not a bill (in GBP/EUR: converted at your rate). Missing data
  shows as "—" or "unknown", never as 0.
- Claude Code plan limits appear only when the signalbox-tap mod reports them (see `docs/SPIKE.md`).
- Quitting the app closes the CLI's stdin, so the CLI exits. The CLI also exits if the app crashes.
