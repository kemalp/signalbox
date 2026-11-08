# signalbox-switch: one person, several Claude Code accounts

> **Status: built (Step 3b), with the recommended choice for every decision in §12.** It is Step 3 of the
> multi-account work: Step 1 (which account each session belongs to) and Step 2 (the transcript retention check) are
> merged and read-only. This document describes the opt-in piece that *writes and launches*. What the build settled is
> in [§13](#13-what-the-build-settled).
>
> Signalbox is unofficial. It is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks
> of Anthropic PBC.

## What it is for

You pay for two Claude subscriptions, say a personal Max plan and a work Team plan, and use Claude Code with both on
one Mac. Claude Code's own answer is one config folder per account, chosen with `CLAUDE_CONFIG_DIR`. Each folder has
its own login, settings and session history ([authentication docs][auth]). That leaves three gaps:

1. **Two histories.** A session started under one account can't be found, listed or resumed from the other.
2. **Switching is manual.** You type `CLAUDE_CONFIG_DIR=…` yourself, or keep two aliases in your head.
3. **No hand-over.** When one account hits its 5-hour limit, you can't continue the session on the other account.

signalbox-switch fills them with five small pieces:

| Piece | What it does | What it writes |
|---|---|---|
| **Set up shared sessions** (once) | Gives every account folder the same transcript tree | Renames out of the second folder's `projects/` (and into its `projects-set-aside/`, if you choose), then one symlink |
| **Active in Terminal** (Accounts screen) | Picks the account that `claude` uses in your terminal | One pointer file |
| **The shim** | A tiny `claude` script that reads the pointer and runs the real `claude` | The script itself, once |
| **Resume with ▸** (History) | Continues a session under another account in a new Terminal window | A one-shot script that deletes itself |
| **Log** (Accounts ▸ Log) | Shows every action above | An append-only audit log |

Everything it writes is under `~/Library/Application Support/signalbox/switch/`, except the setup's renames, the
folders they need and the symlink. Everything is off by default.

## Ground rules

These don't change with this piece:

- **The core stays read-only.** The switch is a separate Swift target, `SignalboxSwitch`. Only the app links it.
  `SignalboxKit`, the CLI and the web server never import or call it. The web server gets no new endpoint and stays
  GET-only.
- **Off by default.** While it is off, nothing is written under `switch/` and every screen looks as it does today.
  The one exception is if you picked a Terminal account at an earlier time: the Accounts screen and the popover
  then show which one (see [§2](#2-the-pointer-which-account-claude-uses-in-your-terminal)). Tests check this.
- **No credentials.** Signalbox never reads, copies or moves `.claude.json`, `.credentials*`, `*.key` files or the
  Keychain. Each config folder keeps its own login, as Claude Code already arranges.
- **No agent config.** Signalbox never writes `settings.json`, `.claude.json`, your shell profile or anything in
  `~/.local/bin`. Where a change is needed there, it shows you the line and you make the edit (see
  [Do it yourself](#7-do-it-yourself)).
- **Signalbox never runs `claude` for this.** Resume opens a Terminal window, which you see, and Terminal runs
  `claude`. The only `claude` runs Signalbox makes itself are still `claude agents --json` and `--version`.
- **Unknown stays unknown.** Accounts are named from each folder's current login (Step 1's hashed ids, plus your
  labels). When a folder's login can't be read, it is shown by its path with "account unknown", never under a
  guessed account.

### How this follows the actions layer in BRAINSTORM

| BRAINSTORM (§4 architecture, §7 v1 roadmap, §9 guardrails) | Here |
|---|---|
| Opt-in, separate piece | `SignalboxSwitch` target; Settings ▸ Advanced ▸ Account switching, off by default |
| `control on --for 8h` expiry | On for 1, 8 (default) or 24 hours, then the controls disable themselves |
| Allowlist of verbs | Exactly four verbs: set the pointer, write the shim, resume in Terminal, run a setup step. No generic command runner |
| Confirm dialogs that name side effects | Every verb has a sheet that shows the exact command or file changes before you confirm |
| `0700` command directory | `switch/` and `switch/resume/` are `0700`; files are `0600` (`0700` for the scripts) |
| Append-only audit log | `switch/audit.jsonl`, opened with `O_APPEND`, one line per action, refusals included |
| Liveness check before `--resume`; never a second writer | Resume is offered only for sessions that aren't live; desktop sessions only as a copy |
| Scrub the parent's `CLAUDE_CODE_*` env | Terminal starts the script from your own environment, so nothing of Signalbox's is inherited |
| Threat model: the browser and other local users, not same-user code | No web surface; private file modes; no HMAC, since same-user code could write these files anyway |

## Background: what Claude Code does today

Checked against the docs on 2026-11-08 and Claude Code 2.1.293.

- **`CLAUDE_CONFIG_DIR`** moves settings, session history and plugins into that folder ([env vars][env]). The global
  config file `.claude.json` moves into it too ([.claude directory][dir]). On macOS the login's Keychain entry is
  keyed to the folder ([authentication][auth]). So each folder has its own login, and nothing in this design touches
  logins. The same page says Console sign-ins without an API key are not kept apart this way. This design is about
  subscription logins. The default account means the variable is **unset**. Setting it to `~/.claude` is not the same thing,
  because `.claude.json` would then be read from `~/.claude/.claude.json`. Signalbox's resume commands already
  respect this (`claudeResumePrefix` in core).
- **`claude --resume <id>`** looks in the current folder's project first, then in every other project of the same
  config folder ([sessions][sessions]). It continues the same session id and transcript file. `--fork-session`
  starts a new id from a copy and leaves the original unchanged (`claude --help`, [sessions][sessions]). By id, a
  session is found only in the config folder whose `projects/` holds its transcript. `--resume` also takes the
  absolute path of a transcript file ([sessions][sessions], [CLI reference][cli]). The docs don't say whether that
  works from another config folder, or whether it then writes to the file in place or copies it. **[verify]**
- **The startup sweep** deletes transcripts, subagent files, tool results and checkpoint snapshots older than
  `cleanupPeriodDays` (default 30). Each config folder sweeps its own `projects/` with its own value. Auto-memory
  files are kept. From Claude Code 2.1.248, desktop app transcripts are kept at any age, unless managed settings set
  a period ([.claude directory][dir]). Step 2 already shows all this per folder.
- **Per-session data outside `projects/`** stays in the folder the session ran in: checkpoint snapshots
  (`file-history/<session>/`), `plans/`, `tasks/`, `session-env/`, `shell-snapshots/`, and your prompt history
  (`history.jsonl`) ([.claude directory][dir]).
- **The desktop app** signs in on its own, and you switch accounts inside the app. Signalbox can't point its Code
  tab at a config folder (see [Out of scope](#8-out-of-scope-and-known-limits)).
- **Not documented:** a `projects/` folder shared between config folders, or a symlinked one. The docs describe
  separate folders only. Also undocumented are the per-project files `sessions-index.json` and
  `<id>.desktop-released.json`. Every part of this design that depends on sharing is marked **[verify]** and is tested in
  temporary config folders before 3b ships (see [Tests](#11-tests)).

## 1. The shared-session layout

The brief asks for one `projects/` tree, with only the login kept per account. The layout keeps your default folder
exactly as it is, and makes the second folder's `projects/` a link to it:

```
~/.claude/                      default account (a plain `claude`); never changed, except that
  projects/                     the second account's transcripts are added here: the one shared tree
  settings.json, plugins/, sessions/, file-history/, …   stay as they are

~/.claude.json                  default account's global config and login reference; never touched

~/.claude-team/                 second account (any path you chose; listed in Settings ▸ Advanced)
  .claude.json                  its login reference; stays
  projects -> /Users/you/.claude/projects     the symlink made by the setup
  settings.json, plugins/, sessions/, file-history/, plans/, history.jsonl, …   stay per account
```

| Shared through `projects/` | Kept per account |
|---|---|
| Session transcripts (`<id>.jsonl`), their subagent and workflow files, and tool results (`<id>/`) | The login (`.claude.json` and the Keychain entry) |
| Auto memory (`<project>/memory/`) | `settings.json`, plugins, hooks, skills, custom commands |
| Per-project files Claude Code keeps for itself (`sessions-index.json`, `<id>.desktop-released.json`; internal) | `sessions/` (which sessions are running now) |
| | Checkpoint snapshots, plans, tasks, prompt history, stats |

Signalbox links only `projects/`. Everything else is either agent config, which Signalbox never writes, or
per-session state that is safe to keep apart. You may link `settings.json` or `plugins/` yourself if you want both
accounts to behave the same. Hooks and permissions would then follow too (see [Do it yourself](#7-do-it-yourself)).

**What changes once the tree is shared:**

- Both accounts' `/resume` pickers list every session, and **Resume with ▸** can target either account.
- Auto memory for a project is shared between the accounts. Both accounts are you, so this is usually what you want.
- **The shortest retention wins.** Each folder's Claude Code sweeps the shared tree with its own
  `cleanupPeriodDays`. A second folder without the setting deletes everything older than 30 days, whatever
  `~/.claude/settings.json` says. That's why the setup refuses to start until every sharing folder has a long
  enough value. Step 2's Health rows already show which folders share a tree. **[verify: the sweep follows the
  link]**
- **Restoring files from checkpoints across accounts.** Snapshots stay in the folder where the session ran. After
  you resume under the other account, `/rewind` can still rewind the conversation, but files from before the switch
  may not restore ("backup missing"). **[verify]**
- **Account attribution of ended sessions.** In a shared tree, a transcript's folder no longer says which login ran
  it. Step 1 already handles this: a transcript in a tree shared by several folders gets no account from its
  location. A session still gets one while it is live (from its folder's `sessions/` file), from recorded account
  lines, or from the signalbox-tap spool, which names the config folder. Plugins are per folder, so install the tap
  in each folder you use. Otherwise an ended terminal session shows "Account unknown", not a guess.
- **Two folders writing one index.** If both accounts update a project's `sessions-index.json`, it is unknown
  whether that is safe, and whether the `/resume` picker depends on the file. **[verify]**

**Why not resume by path, without sharing?** Claude Code can resume a transcript by its path. If that works from the
other folder, **Resume with ▸** could skip the setup. That isn't the plan, for three reasons:

- If the file is written in place, it stays in the first folder's tree while the other login writes to it. Once the
  session ends, Step 1 would then infer the first folder's account from its location. That is a wrong guess, where
  the shared tree honestly says unknown.
- The other folder's `/resume` picker still wouldn't list the session.
- The behaviour is undocumented.

Experiment E1b settles what it actually does. Decision 8 asks whether you want it as an option.

### The setup helper

**Accounts ▸ Set up shared sessions** opens a sheet. It shows a checklist, then the exact file changes, one step at a
time. Each step needs its own confirmation.

**Preconditions.** All of these must pass, and the sheet shows each one:

1. Account switching is on and hasn't expired.
2. The second folder is listed in Settings ▸ Advanced ▸ Claude Code folders. The target is the default folder's
   `projects/` (its real path, if it is itself a link). Folders are compared by real path, so `~/.claude` reached
   through a link, or a `projects/` inside the shared tree (or holding it), is refused outright: planning moves
   there could empty the shared tree.
3. **Retention.** Every folder that will share the tree keeps transcripts at least as long as the default folder
   does, and at least as long as your warning threshold. If you turned the warning off, the minimum is 90 days.
   Step 2's check provides the values, managed settings included. An unknown or invalid value blocks the setup. The
   sheet offers **Copy line** and **Open settings.json**, and you make the edit. Step 2 never follows symlinks, so a
   linked `settings.json` reads as unknown and blocks the setup. Link it after the setup, if at all.
4. **Nothing is running in the folders that will share:** the second folder, and any third folder whose
   `projects/` already links to either tree (it joins the shared tree too, and its retention counts in check 3).
   That means no live session in their `sessions/` or in their `claude agents --json`. The Sessions screen uses the
   same data.
5. **Same volume:** both `projects/` folders are on one volume, so every move is a rename. Nothing is ever copied
   and then deleted. The volume must also support exclusive renames (`VOL_CAP_INT_RENAME_EXCL`), as APFS does.
6. **The second folder's `projects/` is a real folder.** If it is already a link to the shared tree, the sheet says
   "Already set up". A link anywhere else is refused.
7. **Backup** (advice, not checked): the sheet suggests Time Machine or a one-line clone first (see
   [Do it yourself](#7-do-it-yourself)).

**Clashes.** A clash is a path that exists in both trees. Names are compared the way the volume compares them:
ignoring Unicode normalization, and ignoring case on a case-insensitive volume (APFS's default), so `-Code-app`
and `-code-app` are one project folder. Finder's `.DS_Store` files are never clashes: they are always moved aside. Session ids are UUIDs, so transcripts don't clash. The
clashes to expect are `memory/` and `sessions-index.json` in a project that both accounts used. The sheet lists each
one, and you choose:

- **Stop** (the default): nothing moves. Sort it out yourself, then run the setup again.
- **Set the second folder's copy aside:** it moves to `~/.claude-team/projects-set-aside/<project>/<name>`, and the
  default folder's copy stays in the shared tree.

Signalbox never merges, reads or deletes either copy.

**Steps.** Each step shows its full list and asks before it runs:

1. For each project folder that exists only in the second tree, create it in the shared tree and move its entries
   into it: one rename per `<id>.jsonl`, `<id>/`, `memory/`, and so on.
2. Move each entry of the project folders that exist in both trees, the same way.
3. Move the clashes you chose to set aside, creating `projects-set-aside/<project>/` as needed.
4. Remove the now-empty project folders and the second folder's `projects/`, then create the link
   `~/.claude-team/projects -> <shared tree>` (an absolute target) straight away. These run as one step, so no Team
   `claude` can recreate a real `projects/` in between. Removal uses `rmdir` only, which fails if anything new
   appeared. The setup then stops.

**Safety.** Before each step, Signalbox checks again that nothing is running in the second folder and that the
planned sources and targets are unchanged. Every move uses `renamex_np(…, RENAME_EXCL)`, so it fails rather than
replace anything that appeared since the check. The first error stops the setup.

Nothing is rolled back automatically. A half-done setup leaves every file in one of the two trees, so nothing is
lost. The log records every move. Closing the sheet before the last step logs that, and opening it again continues
the same setup, so one undo covers all of it. **Log ▸ Copy undo script** gives a complete shell script for you to
run. It removes the link (only if it still points at the shared tree) and moves every logged entry back, recreating
the folders, then removes the folders the setup created if they are empty. If the setup stopped before the link
step, it first checks every original place and changes nothing if one is taken, instead of skipping it the way
`mv -n` would. Because every move is one entry, sessions created after the setup stay in the shared tree. A session
you continued after the setup moves back with its file.

**What the setup never does:**

- change `~/.claude`, other than adding entries to `projects/`;
- read a file's contents;
- copy anything;
- delete anything except empty folders;
- touch `settings.json`, `.claude.json`, credentials or `sessions/`;
- run while a session in the second folder is live.

## 2. The pointer: which account `claude` uses in your terminal

`~/Library/Application Support/signalbox/switch/active` is one line, `0600`, in a `0700` folder. It holds `default`
(meaning `CLAUDE_CONFIG_DIR` unset) or the absolute path of a listed config folder. Signalbox writes it to a
temporary file and renames that over the old one, so a half-written pointer is never read.

- The only writer is the **Active in Terminal** selector on the Accounts screen. It offers the listed folders, each
  labelled with its current login's account: "Team · ~/.claude-team", or "~/.claude-team · account unknown".
  Choosing the default folder stores `default`, never its path. Setting the variable to `~/.claude` would move the
  global config (see [Background](#background-what-claude-code-does-today)).
- A missing file means the default account, as if there were no shim.
- The Accounts screen and the menu bar popover show the current choice ("Terminal: Team"). Reading Signalbox's own
  file is not an action, so this works while switching is off too.
- Expiry and turning the feature off don't reset the pointer. It is state, not an action, and changing it silently
  would move your terminal to another account behind your back. The popover line makes the current choice visible.

## 3. The shim

When you turn switching on, Signalbox writes `switch/bin/claude`, a POSIX `sh` script of about 40 lines. Its text is
fixed and holds no data of yours. Signalbox rewrites it when its version changes, and logs that.

What it does, in order:

1. **It respects an explicit choice.** If `CLAUDE_CONFIG_DIR` is set, it is used as it is, so
   `CLAUDE_CONFIG_DIR=… claude` still works.
2. **Otherwise it takes the choice an outer run passed on,** in `SIGNALBOX_SWITCH_CHOSEN`, or else reads the
   pointer:
   - missing: the default account;
   - `default`: leave the variable unset;
   - an absolute path to a folder you own: export it;
   - anything else: print what is wrong and exit 1. It never falls back to another account, because running on the
     wrong subscription is the failure this feature exists to prevent.

   Then it exports the result as `SIGNALBOX_SWITCH_CHOSEN` (`default` or the path). A `claude` started inside a
   session, by a hook, a script or the Bash tool, keeps that session's account, even if you change the pointer
   meanwhile. It does so even when Claude Code scrubs `CLAUDE_CONFIG_DIR` from subprocesses
   (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, [env vars][env]).
3. **It finds the real `claude`:** the first executable `claude` on `PATH` that isn't in its own folder and isn't
   another copy of the shim, or `SIGNALBOX_REAL_CLAUDE` when set.
4. **It runs it with `exec`,** with the same arguments, so it keeps the same process id. Claude Code's
   `sessions/<pid>.json` and Signalbox's liveness checks keep working, and signals and the exit code pass straight
   through.

A sketch (3b writes and tests the real one):

```sh
#!/bin/sh
# signalbox-switch shim (written by Signalbox; your edits are overwritten). Unofficial.
set -f
pointer="$HOME/Library/Application Support/signalbox/switch/active"
here=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)

if [ -z "${CLAUDE_CONFIG_DIR-}" ]; then
  if [ -n "${SIGNALBOX_SWITCH_CHOSEN-}" ]; then choice=$SIGNALBOX_SWITCH_CHOSEN   # an outer run chose
  elif [ -e "$pointer" ]; then choice=; IFS= read -r choice < "$pointer"
  else choice=default
  fi
  case $choice in
    default) unset CLAUDE_CONFIG_DIR ;;
    /*) if [ -d "$choice" ] && [ -O "$choice" ]; then CLAUDE_CONFIG_DIR=$choice; export CLAUDE_CONFIG_DIR
        else echo "signalbox-switch: $choice isn't a folder you own." >&2
             echo "Pick an account in Signalbox, or delete $pointer to use your default." >&2; exit 1; fi ;;
    *) echo "signalbox-switch: can't read $pointer. Pick an account in Signalbox, or delete it." >&2; exit 1 ;;
  esac
fi
# Pass the choice on, so a nested claude keeps it even if the pointer changes or the variable is scrubbed.
case ${CLAUDE_CONFIG_DIR-} in
  '') SIGNALBOX_SWITCH_CHOSEN=default; export SIGNALBOX_SWITCH_CHOSEN ;;
  /*) SIGNALBOX_SWITCH_CHOSEN=$CLAUDE_CONFIG_DIR; export SIGNALBOX_SWITCH_CHOSEN ;;
esac

real=${SIGNALBOX_REAL_CLAUDE-}
if [ -z "$real" ]; then
  IFS=:
  for d in $PATH; do
    [ -n "$d" ] || continue
    [ "$(CDPATH= cd -P -- "$d" 2>/dev/null && pwd -P)" = "$here" ] && continue
    [ -f "$d/claude" ] && [ -x "$d/claude" ] || continue
    head -n 2 "$d/claude" 2>/dev/null | grep -q '^# signalbox-switch shim' && continue
    real=$d/claude; break
  done
  unset IFS
fi
[ -n "$real" ] || { echo "signalbox-switch: no claude found on PATH besides this shim." >&2; exit 127; }
exec "$real" "$@"
```

**Hooking it in.** You paste this yourself; Signalbox never edits shell profiles. The sheet offers two ways and
recommends the first:

- **A shell function** (recommended). It changes what you type in an interactive shell. Scripts, editors and other
  tools that run `claude` are unaffected. Claude Code's Bash tool replays your shell functions (shell snapshots,
  [.claude directory][dir]), so a `claude` run inside a session goes through the shim too. It keeps the session's
  account (step 2). The `unalias` line matters: an older installer may have left a `claude` alias, and defining a
  function over it is a parse error in zsh and bash.

  ```sh
  # zsh or bash: ~/.zshrc or ~/.bashrc
  unalias claude 2>/dev/null
  function claude { "$HOME/Library/Application Support/signalbox/switch/bin/claude" "$@"; }
  ```
  ```fish
  # fish: ~/.config/fish/functions/claude.fish
  function claude; "$HOME/Library/Application Support/signalbox/switch/bin/claude" $argv; end
  ```

- **A `PATH` entry.** Every program started from your shell then goes through the shim, including editors and
  scripts.

  ```sh
  export PATH="$HOME/Library/Application Support/signalbox/switch/bin:$PATH"
  ```

**Signalbox itself never goes through the shim.** The app hands the CLI your login shell's `PATH`, so with the `PATH`
form, `findBinary("claude")` would find the shim. Then `claude agents --json` for the default folder would run under
the pointer's account. 3b makes `findBinary` skip the shim folder and any file carrying the shim's marker, and
`doctor` says which `claude` it uses and that it skipped the shim. The shim lives in Signalbox's own folder, not
`~/.local/bin`, so the native installer's launcher is untouched ([setup][setup]). Whether `claude doctor` or
`claude update` comment on a wrapper or a function is **[verify]**.

**History's copied resume line follows the shim too.** The existing **Copy resume command** is read-only and stays
as it is. Once the shim is hooked in, its plain `claude --resume <id>` and `env -u CLAUDE_CONFIG_DIR claude --resume
<id>` forms run under the Terminal account, like any `claude` you type. After the setup that is harmless, since
every account sees every session. Only the `CLAUDE_CONFIG_DIR=… claude --resume` form names a folder explicitly. To
pick the account on purpose, use **Resume with ▸**.

If a settings file sets `CLAUDE_CONFIG_DIR` through its `env` block ([env vars][env]), the shim can't see it.

## 4. Resume with ▸ another account

**Where:** the History row's context menu and the History inspector: **Resume with ▸ Team · ~/.claude-team**. It
appears only while switching is on.

**When it is offered:**

- **A Claude Code session with a transcript.** Sessions that exist only in the Claude app's list have none, so they
  can't be resumed.
- **An id that is safe to put in a shell command** (core's `SAFE_ID`, as for the existing resume line).
- **The session isn't live in any listed folder**, going by the same data as the Sessions screen. A live one shows
  "Quit it first". Resuming a live session would make two writers on one transcript, which BRAINSTORM §4 found
  breaks things.
- **The target folder can see the transcript.** That means the folder shares the transcript's tree: every folder
  after the setup, but only the session's own folder before it. Before the setup, the menu says "Set up shared
  sessions to resume under another account".
- **Desktop sessions only as a copy** (`--fork-session`). The desktop app can write to them again at any time, and
  Signalbox can't see whether it will.

**The confirm sheet** shows:

- the session (title, project, last active);
- the target account and folder;
- the exact command;
- a **Start as a copy** toggle (`--fork-session`: a new session id, and the original is left as it is);
- a cost note: "Team starts with a cold cache. The whole conversation (about N tokens, when Signalbox knows it) is
  sent again with your first message and counts against Team's limits." On Pro, Max and Ultra plans, Claude Code
  may also ask "Resume this conversation?" first, after a long break or on a different model ([sessions][sessions]).

If the session's folder is gone, the `cd` is left out and the sheet says so, as the existing resume line already
does.

**When you confirm,** Signalbox checks again, whatever the menu showed. The session must not be running now, the
folder must see its transcript, and the session must not have been opened in Terminal in the last two minutes (until
Terminal starts it, the fleet can't show it as running). A refusal is logged. Then:

1. Signalbox writes `switch/resume/<random>.command` (`0700`, in a `0700` folder):

   ```sh
   #!/bin/sh
   rm -f -- "$0"
   cd -- '/Users/you/code/app' || exit 1
   CLAUDE_CONFIG_DIR='/Users/you/.claude-team'; export CLAUDE_CONFIG_DIR    # or: unset CLAUDE_CONFIG_DIR
   SIGNALBOX_SWITCH_CHOSEN='/Users/you/.claude-team'; export SIGNALBOX_SWITCH_CHOSEN   # or: default
   exec '/Users/you/.local/bin/claude' --resume '11111111-2222-3333-4444-555555555555'
   ```

   Every value is single-quoted (core's `shellQuote`), the id is checked again, and `claude` is the real binary,
   never the shim.

2. It runs `/usr/bin/open -a Terminal <file>` from an argument array: no shell, no AppleScript, and so no
   Automation permission. Terminal only for now: iTerm wasn't installed where this was built, so `open -a iTerm`
   couldn't be tested (§13).
3. Terminal opens a new window and runs the script in your own environment. The script deletes itself first, then
   runs `claude`. You see everything, and you can close the window.
4. One audit line records it. A script that Terminal never ran is deleted when Signalbox next starts, if it is more
   than an hour old, and that deletion is logged too (`resume.swept`).

Signalbox never runs `claude` for this, sends no prompt, never compacts, and doesn't watch the window. A headless
(`-p`) resume isn't offered.

## 5. The audit log

`switch/audit.jsonl` is `0600` and opened with `O_APPEND | O_CREAT | O_NOFOLLOW`. Each line is one JSON object for
one action, keys sorted, written when the action ends. Refused and failed actions are logged too, while switching is
on. While it is off, nothing is written, so an attempt then is refused without a line. At 5 MiB it is renamed to
`audit.1.jsonl`, and only that one older file is kept.

| Field | Type | Notes |
|---|---|---|
| `v` | 1 | Format version |
| `ts` | ISO 8601, UTC, ms | When the action ended |
| `action` | string | One of `switch.enabled`, `switch.disabled`, `switch.expired`, `shim.written`, `pointer.set`, `resume.opened`, `resume.swept`, `setup.checked`, `setup.step`, `setup.stopped`, `setup.finished`. Kept as a string, so a newer Signalbox's lines still read |
| `result` | string | `ok`, `refused`, `failed` or `cancelled` |
| `reason` | string? | Why it was refused or failed: a check's name or an OS error. Never file content |
| `until` | ISO 8601? | For `switch.enabled`: when it expires |
| `from`, `to` | string? | For `pointer.set`: the old and new value (`none` when there was no pointer). For the link step: the link and its target |
| `account` | `{ id, label? }`? | Step 1's hashed `acct-…` id and your own label. Never a raw id, email or name |
| `configDir` | path? | The target folder |
| `sessionId` | string? | For `resume.opened` |
| `fork` | bool? | For `resume.opened` |
| `terminal` | string? | `Terminal` (the only one for now) |
| `run` | string? | One shared-sessions setup: every setup line of it carries the same id (the undo script is built from it) |
| `step` | number? | For `setup.step`: 1 to 4 |
| `moves` | `[{ from, to }]`? | For `setup.step`: every rename, as absolute paths |
| `created` | `[path]`? | For `setup.step`: the folders it created (the undo removes them again when they are empty) |
| `paths` | `[path]`? | Other files or folders written or removed: the pointer, the shim, a resume script, an emptied folder, the link |
| `appVersion` | string | Signalbox's version |

The log never holds message content or titles. Paths are shown as they are, as everywhere else in Signalbox.
Synthetic examples:

```json
{"action":"switch.enabled","appVersion":"0.2.0","result":"ok","ts":"2026-11-08T09:00:00.000Z","until":"2026-11-08T17:00:00.000Z","v":1}
{"account":{"id":"acct-1a2b3c4d5e6f","label":"Team"},"action":"pointer.set","appVersion":"0.2.0","configDir":"/Users/you/.claude-team","from":"default","paths":["/Users/you/Library/Application Support/signalbox/switch/active"],"result":"ok","to":"/Users/you/.claude-team","ts":"2026-11-08T09:01:12.345Z","v":1}
{"action":"resume.opened","appVersion":"0.2.0","configDir":"/Users/you/.claude-team","reason":"switching is off","result":"refused","sessionId":"11111111-2222-3333-4444-555555555555","ts":"2026-11-08T09:20:03.001Z","v":1}
{"action":"setup.step","appVersion":"0.2.0","configDir":"/Users/you/.claude-team","moves":[{"from":"/Users/you/.claude-team/projects/-Users-you-code-app","to":"/Users/you/.claude/projects/-Users-you-code-app"}],"paths":[],"result":"ok","run":"3f0c…","step":1,"ts":"2026-11-08T09:31:40.120Z","v":1}
```

**Accounts ▸ Log** reads both files, newest first, with a filter by action. For a setup it offers **Copy undo
script** ([§1](#the-setup-helper)). Before running it, quit Claude Code in both folders.

## 6. On, off and expiry

- **Settings ▸ Advanced ▸ Account switching** is off by default. Turning it on opens a sheet that lists what the
  feature writes (the table at the top) and the "unofficial" line. You choose how long it stays on: 1 hour,
  8 hours (default) or 24 hours. The first time, it writes the shim.
- **While it is on:**
  - the Accounts screen shows **Active in Terminal**, **Set up shared sessions** and **Log**;
  - History shows **Resume with ▸**.
- **When the time is up,** or you turn it off: the controls disappear again, as when the feature was never on, and
  the log gets `switch.expired` or `switch.disabled`. Expiry is checked on every tick and on launch, so it is logged
  even if the app was closed at the deadline. If a pointer exists, the Accounts screen keeps its "Terminal: Team"
  line and adds "Account switching is off (Settings ▸ Advanced)".
- **What stays:** the pointer, so your terminal keeps the account you chose (the popover shows it), and the shim,
  the log and the shared layout. Nothing reverts by itself.
- **Removing it completely,** in this order:
  1. If you want to undo the shared layout, turn switching on, use **Log ▸ Copy undo script** and run it. It needs
     the log, so do this first. Keeping the layout is harmless as long as every sharing folder keeps a long
     retention.
  2. Remove the function or `PATH` line from your shell profile.
  3. Delete the folder: `rm -r "$HOME/Library/Application Support/signalbox/switch"`.

## 7. Do it yourself

Signalbox shows these and you run them. You decided this in the plan review: Signalbox writes neither agent config
nor backups.

- **Raise retention.** **Copy line** gives you `"cleanupPeriodDays": 365`. **Open settings.json** runs
  `open -t <folder>/settings.json`. If the file doesn't exist, the sheet shows a whole file to create instead,
  because Signalbox won't create it.
- **Back up transcripts.** Time Machine covers `~/.claude` unless it is excluded. If your home folder is on an
  external drive, check that the drive is included: Time Machine leaves external drives out by default. For a quick
  copy before the setup, an APFS clone takes almost no space until files change (same volume only):

  ```sh
  cp -cR "$HOME/.claude/projects" "$HOME/claude-projects-$(date +%F)"
  ```

  For a daily copy, add that line to your own scheduler (in a crontab, write each `%` as `\%`). Signalbox doesn't
  install one.
- **Share more than transcripts.** If you want both accounts to use the same settings, plugins or skills, link them
  yourself, for example `ln -s ~/.claude/settings.json ~/.claude-team/settings.json`. Hooks, permissions, `env`
  values and `cleanupPeriodDays` then follow too. Step 2's check never follows symlinks, so it reads a linked
  `settings.json` as unknown. Health then shows that folder's retention as unknown, and the setup refuses to start.
  Link it after the setup, if at all.
- **Hook in the shim:** the shell lines in [§3](#3-the-shim).

## 8. Out of scope and known limits

- **The Claude desktop app's Code tab** uses the app's own login, which you switch inside the app. Signalbox can't
  point it at a config folder, and **Resume with ▸** targets Terminal only. You can still continue a desktop session
  in Terminal under either account, as a copy, once its transcript is in a shared tree.
- **Sessions that exist only in the Claude app's list** have no transcript, so they can't be resumed.
- **Checkpoint file restore** across accounts may fail ([§1](#1-the-shared-session-layout)).
- **Ended terminal sessions in a shared tree** have no account unless they were seen live, carry account lines, or
  the tap recorded their folder.
- **Prompt history** (up arrow) stays per account.
- **History's copied resume line** follows the Terminal account once the shim is hooked in ([§3](#3-the-shim)).
- **Console sign-ins without an API key** aren't kept apart by config folders ([authentication][auth]). This feature
  is for subscription logins.
- **No automatic switching.** Nothing moves you to the other account when a limit is near. That would be a rule,
  and rules are a later, separate opt-in (BRAINSTORM §7, "Later").
- **Codex and Gemini CLI** aren't covered.

## 9. Code layout for 3b

- **`apps/macos/Sources/SignalboxSwitch`** (new library target, linked by the app only):
  - Pure parts: `SwitchPaths`, `Pointer` (parse and format), `ShimScript` (the text and its marker), `ResumeScript`
    (the text and its checks), `SetupPlan` (from a listing of both trees to preconditions, clashes, steps and undo
    lines), `AuditEntry` (encoding), `SwitchWindow` (on, off and expiry).
  - The executor: a `SwitchFileSystem` protocol (`mkdir` with a mode, atomic write, append, `renamex_np` with
    `RENAME_EXCL`, `rmdir`, `unlink` (only for Signalbox's own resume scripts), `symlink`, `lstat`, volume id and
    capabilities), with a real implementation and an in-memory one for tests; plus `SwitchActions`, the four
    allow-listed verbs, each of which checks the window, acts, then appends its log line. The sweep of stale resume
    scripts is the only write outside a verb, and it is logged too.
- **App target:**
  - the Settings ▸ Advanced section and its sheet;
  - on the Accounts screen, the selector, the setup sheet and the Log tab;
  - on History, the **Resume with ▸** menu and confirm sheet;
  - the popover's "Terminal: …" line.
- **`apps/cli/src/binaries.ts`:** `findBinary` skips the shim folder and marked files. `doctor` shows which
  `claude` is used. This read-only change is the only one in the CLI.
- **`Package.swift`:** the new target and `SignalboxSwitchTests`. `SignalboxKit` gains nothing that writes.
- **Docs:**
  - README: a "What signalbox-switch writes, where, and how to turn it off" section.
  - CLAUDE.md: the changes below.
  - apps/macos/README: the new target.

## 10. CLAUDE.md changes

- Replace "Never resume, message or compact a session you did not create" with: "Never resume, message or compact a
  session you did not create. The one exception is signalbox-switch's Resume with. It is off by default, needs a
  confirm sheet, works only for sessions that aren't live in any config dir (desktop sessions only as a copy), and
  only opens Terminal on a script that runs `claude --resume`. Signalbox never runs claude for it, never sends a
  prompt and never compacts."
- Add a hard rule: "signalbox-switch (`apps/macos/Sources/SignalboxSwitch`) is the only code that writes outside
  Signalbox's own settings and labels. It writes its own files under `~/Library/Application Support/signalbox/switch/`
  (pointer, shim, resume scripts, audit log), plus the one-time setup's renames out of a second config dir's
  `projects/` (into the shared tree, or into that dir's `projects-set-aside/`), the folders those need, and the
  symlink that replaces `projects/`. Every write is audited. It never writes agent config, `~/.claude`
  (beyond adding entries to `projects/`), credentials or shell profiles. SignalboxKit, the CLI and the web server
  never import or call it."
- Layout: add the new target to the `apps/macos` line.

## 11. Tests

**Experiments first,** in temporary config folders, never the real ones. These settle the **[verify]** marks:

| # | Question | How |
|---|---|---|
| E1 | Does `--resume <id>` under folder B find a session whose transcript reached B's tree through a `projects/` symlink? | Synthetic transcript in A's tree, B links to it. Compare `claude -p --resume <id> x` against an unknown id under B (the "No conversation found" error vs. a later failure such as no login). `-p` skips the onboarding screens, and no login means nothing is sent |
| E1b | Does `--resume <path>` from folder B write to A's file in place, or copy it into B's tree? | Needs a login, so it can't run in a temporary folder. Run it once by hand with your second folder on a throwaway session, after a backup |
| E2 | Does B's startup sweep delete old files through the link? | B with `cleanupPeriodDays: 1`, old synthetic files in A's tree, if the sweep can be triggered without a login. Otherwise documented as assumed, which the retention precondition covers either way |
| E3 | Does `open -a iTerm x.command` run the script? | A script that touches a marker file |
| E4 | Do `claude doctor` and `claude update` comment on the function or `PATH` shim, or rewrite anything? | Temporary config folder, both forms |
| E5 | Does a `--fork-session` copy repeat usage lines, and does Signalbox's dedup count them once? | Synthetic transcripts in the copy's layout |
| E6 | What writes `sessions-index.json`, does the `/resume` picker depend on it, and is it safe when two folders write it? | Watch the file in temporary folders while E1 runs; otherwise note it as a known risk |

**Acceptance on your Mac,** after a backup: run the setup on your real second folder, then resume one session each
way, and check History, the account chips and the log.

**Unit tests (Swift, `SignalboxSwitchTests`):**

| Area | Cases |
|---|---|
| Off by default | Temporary HOME: nothing under `switch/` until it is turned on; the default screens don't show the controls |
| Window | On for 1/8/24 h; expiry disables the verbs, keeps the pointer, and logs once, also when noticed at launch |
| Pointer | Atomic write, `0600`, `0700` folder; `default` and path round-trip; the default folder is stored as `default`, never as its path; unlisted folders refused |
| Shim (runs real `/bin/sh` and `dash` with a fake `claude`) | No pointer; `default`; a folder; a missing or foreign folder (exit 1); explicit `CLAUDE_CONFIG_DIR`, absolute and relative; nested run after the pointer changes; nested run with `CLAUDE_CONFIG_DIR` scrubbed; same pid (`exec`); spaces in every path; a second copy of the shim on `PATH` (no loop); no other `claude` (exit 127) |
| Hook lines | The zsh, bash and fish snippets load and call the shim, also when a `claude` alias is already defined |
| Resume | Offered or not: live, desktop (copy only), no transcript, unsafe id, other tree before the setup, unknown login (shown by path); script quoting (spaces, quotes, non-ASCII in the folder); `open` gets an argument array; old scripts are swept |
| Setup plan | Each precondition blocks (live; retention shorter than the default folder's, below the threshold, below 90 days with the warning off, unknown or invalid; other volume; no exclusive rename; `projects/` already a link; link elsewhere); clashes: stop vs. set aside; a new file between steps stops the next step; removal and link in one step; the default folder only gains entries; `rmdir` only |
| Undo script | Run on a temporary layout after a setup: restores the original tree exactly; stops at the first taken place; leaves sessions created after the setup in the shared tree |
| Audit | One line per verb including refusals; `O_APPEND`; rotation at 5 MiB; no titles, raw ids or content (string scan) |

**CLI:** `findBinary` skips the shim folder and marked files; `doctor` names the `claude` used.

**Probes and renders:**

- `click-probe.sh`: reaches the selector and the **Resume with ▸** menu when on, and finds neither when off.
- Snapshots: Settings with switching on, Accounts with the selector, the confirm sheet, the setup sheet, the Log.

## 12. Decisions for you

Each has a recommendation. Say which you'd like changed.

1. **Who runs the setup's renames?** Recommended: Signalbox, with the checks above. The checks right before each
   step and `RENAME_EXCL` are what make it safe. Alternative: Signalbox only shows a script and you run it.
2. **The Resume default:** recommended: continue the same session, with **Start as a copy** as an option and
   desktop sessions always as a copy. Alternative: always a copy, so Signalbox never appends to a transcript it
   didn't start.
3. **A broken pointer:** recommended: the shim refuses to run and says why. Alternative: fall back to the default
   account.
4. **Hooking in the shim:** recommended: the shell function, with the `PATH` line as the alternative.
5. **Expiry choices:** 1, 8 or 24 hours, default 8.
6. **Clashes:** recommended: offer "set aside" as well as stop. Alternative: stop only.
7. **Share `file-history/` too,** so checkpoint restore works across accounts? Recommended: not now. It is a second
   merge with its own clashes, for a rare need.
8. **Resume by path without the setup,** if E1b shows it writes in place? Recommended: no. Step 1 would then infer
   the wrong account for those sessions once they end ([§1](#1-the-shared-session-layout)).


## 13. What the build settled

**Experiments** (run in throwaway config folders with a fake home and an empty environment, so no login or token
was involved; Claude Code 2.1.293):

| # | Result |
|---|---|
| E1 | **Works.** Under folder B, whose `projects` links to A's tree, `claude -p --resume <id>` gets past the lookup ("Not logged in") for a session in A's tree, and an unknown id gives "No conversation found". Resume by path gets past it too |
| E1b | Not run: it needs a login. Decision 8 is no, so the feature doesn't depend on it |
| E2 | Inconclusive: without a login, Claude Code didn't run its startup sweep, so a file older than B's `cleanupPeriodDays: 1` survived. The retention check covers it either way |
| E3 | iTerm isn't installed here, so `open -a iTerm` couldn't be tested. Resume opens Terminal only |
| E4 | Not run: `claude update` changes the installed binary, and `claude doctor` is interactive. The shim lives outside `~/.local/bin`, so the native launcher is untouched either way |
| E5 | Signalbox's usage dedup drops a repeated message and request id in a second file, so a copy's repeated lines count once in the totals. Whether `--fork-session` copies them needs a login |
| E6 | Nothing wrote `sessions-index.json` during E1. Claude Code did create the project's `memory/` folder through the link, and nothing appeared in the fake home |

**Built as designed, plus** what an independent review of the build found and what was fixed:
- Folders are compared by real path, and a setup that would overlap the shared tree is refused.
- Every move is one entry, so the undo leaves later sessions in place.
- The undo checks before it changes anything.
- A setup left halfway keeps its run.
- Clash detection follows the volume's case rules.
- Third folders count in the checks.
- Resume checks again in the verb and has a two-minute guard.
- Terminal is opened off the main thread.
- Nothing at all is written while switching is off.

Other changes:
- A second folder with no `projects/` yet needs only the link step.
- The shim, when no pointer exists, behaves as the default account and passes that choice on to nested runs.
- Before each setup step, Signalbox plans again from a fresh listing. It runs the step only if it is exactly the step
  you confirmed.
- The click probe checks that switching is off by default and has written nothing (`switch=ok`). It and the
  notification dry run point `SIGNALBOX_SWITCH_ROOT` at their own folders.
- The snapshot renderer draws the switch screens from synthetic folders under `/Users/you`, with a preview switch
  that reads and writes nothing.

[auth]: https://code.claude.com/docs/en/authentication
[env]: https://code.claude.com/docs/en/env-vars
[dir]: https://code.claude.com/docs/en/claude-directory
[sessions]: https://code.claude.com/docs/en/sessions
[cli]: https://code.claude.com/docs/en/cli-reference
[setup]: https://code.claude.com/docs/en/setup
