# Day-0 spike: do mods work in a desktop Code session?

This fills in the Day-0 go/no-go table in `docs/BRAINSTORM.md` §12. It takes about 20 minutes.

You load two mods into **one new throwaway desktop Code session**:

| Mod | Folder | What it does |
|---|---|---|
| `signalbox-tap` | `plugins/signalbox-tap` | The real tap. On session start, measure and end it writes `~/Library/Application Support/signalbox/spool/<sessionId>.json` (numbers only). Nothing else. |
| `spike-probe` | `research/mods/spike-probe` | Records what the tap and the engine do, and runs the active checks **only when you type** `/spike-check` or `/spike-rename`. Writes `spool/spike-results-<sessionId>.json`. |

## Ground rules

- **Use a new session, in a scratch folder outside any repo.** Never an existing session, and never this repo's folder.
- Load the mods **only** through that session's own mods folder (`~/.claude/dev-mods/<session id>/`). Do **not** put them in `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`: that would load the probe into every session. Do not `/plugin install` them.
- `/spike-check` is read-only. It calls `ccd_session_mgmt` `list_sessions` (limit 5) and `get_usage`, and makes one `GET /ping` over a Unix socket to the test listener. `/spike-rename` renames **this throwaway session** and nothing else.
- Neither mod uses `$.store`, settings, `$.prompt`, `$.process` or the network. `claude plugin validate <folder>` prints exactly what each one calls.
- The probe never stores message text. MCP replies are reduced to their shape: strings become `"<string N>"`, except short labels under `get_usage`'s `plan`.
- Don't `/clear` during the spike. It changes the session id, and the results would be split across two files.
- Row 6 of the table (`$.command.run('model')` with a settings diff) is **not** in this kit. `/model` can change your global default, so it stays on Day 5–7 as planned.

## 0. Before you start (terminal)

```sh
REPO=/path/to/signalbox                            # the absolute path of your clone
claude --version                                   # expect 2.1.293 or newer
cd "$REPO" && bun test plugins/signalbox-tap       # tap unit tests
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test "$REPO/plugins/signalbox-tap"       # engine-native tests
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test "$REPO/research/mods/spike-probe"
claude plugin validate "$REPO/plugins/signalbox-tap"
claude plugin validate "$REPO/research/mods/spike-probe"
shasum -a 256 ~/.claude/settings.json              # note it; compared again at the end
mkdir -p ~/scratch/signalbox-spike
```

Start the socket listener in its own terminal tab (set `REPO` there too) and leave it running:

```sh
bun "$REPO/research/mods/spike-probe/listener.ts"
```

It prints `nonce xxxxxxxx`. Write the nonce down. The socket is `~/Library/Application Support/signalbox/spike.sock` (directory 0700, socket 0600), and the listener stops by itself after 30 idle minutes.

## 1. Open the throwaway session

In the Claude desktop app, open the Code tab, start a **New session**, and pick `~/scratch/signalbox-spike` as its folder. Make sure it runs on your claude.ai subscription login, not an API key, or `rateLimits` will be empty by design.

## 2. Put the two mods in that session's mods folder

Paste this as the first prompt in the new session, with `<repo>` replaced by the absolute path of your clone:

```text
Load the plugin-authoring skill. Then copy two existing mod folders, unchanged, into this
session's mods folder (the dev-mods folder the skill names) with exactly these commands,
where DEST is that folder:

  rsync -a --exclude '.claude-plugin/types/' --exclude 'test/' --exclude 'tests/' <repo>/plugins/signalbox-tap "$DEST/"
  rsync -a --exclude '.claude-plugin/types/' --exclude 'tests/' <repo>/research/mods/spike-probe "$DEST/"

Do not write, edit or generate any mod files yourself. Do not set CLAUDE_CODE_PLUGIN_DIRS
and do not edit any settings file. When the copy is done, print the two destination
folders and stop.
```

When the engine asks **"Enable hot reloading for this session?"**, choose **Enable for this session**. The setting covers only this session. The mods load when that turn ends.

**What to note (row 0):**

- Did the question appear in the desktop app?
- After the turn ends, do you see a toast `spike-probe loaded: /spike-check, /spike-rename, /spike-status`, and a status line starting `spike:` under the prompt?
- Any dim transcript line starting `signalbox-tap:` or `spike-probe:` means a hook failed or a module didn't load. Copy it.

If the question never appears, or the notice says hot reloading is **off**, write down the reason it gives and go to [Fallback](#fallback-mods-do-not-load-in-desktop).

## 3. Send one short prompt

```text
Reply with just: ok
```

The reply ends a main-thread turn, so `session.measure` should fire. Wait about 3 seconds. The status line should change to `spike: measure+spool pass (1) · rateLimits …`.

## 4. Read the passive results

Type `/spike-status`. It prints the verdicts, the session id, the engine version, the surface (`desktop` expected), and every check as JSON.

Then, in a terminal (numbers only, safe to look at):

```sh
SPOOL="$HOME/Library/Application Support/signalbox/spool"
ls -la "$SPOOL"; ls -ld "$SPOOL"     # note the directory mode (the contract wants 0700)
cat "$SPOOL/<session id>.json"       # the tap's TapSpool v1 record
```

## 5. Run the read-only active checks

Type `/spike-check`. It takes a few seconds at most, with a 20 s timeout per call.

- **Did any permission prompt appear?** The mod API says `$.mcp.call` from a plugin needs none. Note it either way.
- The listener tab should print one `GET /ping` line. `httpSocket.reply.nonce` must equal the nonce you wrote down.
- `mcpGetUsage.shape.plan` shows the plan windows. Look for a per-model weekly row (Weekly Fable). `selfIsThisSession` says whether `get_usage`'s default `"self"` meant this session when the mod called it.

## 6. Rename via `$.command.run`

```text
/spike-rename signalbox-spike-renamed
```

The rename runs from a timer just after the command returns, and a toast reports `spike-rename: pass` or `fail`. **Check that the session's title in the sidebar changed.** The check passes only if it did. Then:

```sh
shasum -a 256 ~/.claude/settings.json   # must match the value from step 0
```

## 7. Fill in the table

Run `/spike-status` once more and fill this in. You can paste the results file (`spool/spike-results-<session id>.json`) into BRAINSTORM. It holds numbers, kinds, key names, lengths and short plan labels only. Skim it before you share it.

| # | Check (new throwaway desktop session) | Where to look | Pass when | Result | Notes |
|---|---|---|---|---|---|
| 0 | Mods load via the per-session mods folder | Step 2 | Question shown, toast and `spike:` status line visible | | reason if "off" |
| 1 | `session.measure` fires and the spool file appears | `checks.measureAndSpool` | `pass`: `measures ≥ 1`; `tapSpool.found`, `parseOk`, `v: 1`, `sessionMatches: true` | | spool dir mode: |
| 2 | `rateLimits` non-empty after one prompt | `checks.rateLimits` | `pass`; list `kinds` (e.g. `five_hour`, `seven_day`, anything else) | | `from`: start or measure |
| 3a | `$.mcp.call('ccd_session_mgmt','list_sessions')` | `checks.mcpListSessions` | `pass`, `json: true`, `count` = your other sessions (max 5) | | permission prompt? `ms` |
| 3b | `$.mcp.call('ccd_session_mgmt','get_usage')` | `checks.mcpGetUsage` | `pass`; `shape.plan` has the windows | | per-model weekly row? `selfIsThisSession`? |
| 4 | `$.http.fetch` with `socketPath` reaches the listener | `checks.httpSocket` + listener tab | `pass` and `reply.nonce` = listener nonce | | |
| 5 | `$.command.run('rename', …)` from a registered command | `checks.rename` + sidebar | `pass` **and** the sidebar title changed; settings hash unchanged | | `outputHead` |
| 6 | `$.command.run('model', …)` + settings diff | — | Deferred to Day 5–7, not in this kit | n/a | |

Extra observations worth one word each: is the plugin status line visible in desktop? Are toasts visible? Did the listener log anything besides the one `GET /ping`?

**What each result means** (from BRAINSTORM §12):

- **Row 1 pass:** official per-session context and cost. **Fail:** the transcript fallback for context. Dollar and fleet features are unaffected.
- **Row 2 pass:** 5h and 7d gauges from the spool. **Fail:** the gauge reads "unknown, open /usage". The terminal status-line tee still works.
- **Row 3 pass (both):** fleet list and plan windows (including Weekly Fable) come from first-party desktop tools with no model turn. Re-scope v1 so desktop model, effort and rename use `set_session_*`, and levers handles only compact and rules. **Fail:** keep the current design.
- **Row 4 pass:** UDS becomes a transport option. **Fail:** file polling (G2), which is the default anyway.
- **Row 5 pass:** levers v1 is feasible in desktop. **Fail:** desktop stays read-only and links out to Remote Control for actions.

## 8. Clean up

Do this after the table is filled in.

1. **Unload the mods.** In a terminal, delete that session's mods folder. The session id is printed by `/spike-status`:
   ```sh
   rm -rf ~/.claude/dev-mods/<session id>
   ```
   Then archive the throwaway session in the sidebar.
2. **Stop the listener** with Ctrl-C in its tab. That removes `spike.sock`. If the listener died some other way:
   ```sh
   rm -f "$HOME/Library/Application Support/signalbox/spike.sock"
   ```
3. **Remove the spike's spool files** (keep the results file elsewhere first if you want it):
   ```sh
   rm -f "$HOME/Library/Application Support/signalbox/spool/spike-results-"*.json \
         "$HOME/Library/Application Support/signalbox/spool/<session id>.json"
   # nothing else uses it yet, so the whole directory can go:
   rm -rf "$HOME/Library/Application Support/signalbox"
   ```
4. **Remove the scratch folder:**
   ```sh
   rm -rf ~/scratch/signalbox-spike
   ```
5. **Check that nothing persisted:**
   ```sh
   shasum -a 256 ~/.claude/settings.json                        # same as step 0
   grep -c CLAUDE_CODE_PLUGIN_DIRS ~/.claude/settings.json      # 0
   ls ~/.claude/dev-mods/ 2>/dev/null                           # no throwaway id left
   claude plugin list | grep -E 'signalbox-tap|spike-probe'     # no output
   ```

Hot reloading was enabled for the throwaway session only, so other sessions never loaded either mod.

## Fallback: mods do not load in desktop

If step 2 reports hot reloading **off**, or no question appears, then rows 0–5 are "unknown in desktop". Write down the exact reason. It decides between "mods can't be dev-loaded in desktop" and "they need an install or `CLAUDE_CODE_PLUGIN_DIRS`", and that decision belongs in BRAINSTORM §11, not in this spike.

To still learn the mechanics, you can run steps 3–6 in a terminal session. `--plugin-dir` applies to that one invocation only:

```sh
cd ~/scratch/signalbox-spike
claude --plugin-dir "$REPO/plugins/signalbox-tap" \
       --plugin-dir "$REPO/research/mods/spike-probe"
```

Label every result **terminal**. In a terminal, `ccd_session_mgmt` is a desktop-only server, so rows 3a and 3b are expected to fail and tell you nothing. Loading this way lays `.claude-plugin/types/` inside the repo's mod folders, which is gitignored. Clean up with steps 2–5 above.
