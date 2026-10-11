# signalbox-tap

A read-only Claude Code mod (function hooks, Claude Code 2.1.293+). On `session.start`, `session.measure` and `session.end` it writes this session's usage figures to

```
~/Library/Application Support/signalbox/spool/<sessionId>.json
```

as a `TapSpool` v1 record (`packages/core/src/types.ts`): context fill, rate-limit windows and cost, plus `seq`, `event` and `writtenAt`. Figures the engine doesn't have are left out, never written as 0.

That is all it does. It makes no network calls, runs no commands, submits no prompts, changes no settings and draws no UI. On failure it writes one line to the debug log (`claude --debug`), and its hooks never throw.

`claude plugin validate plugins/signalbox-tap` lists exactly what it touches: `$.env.get(HOME)`, `$.session.id`, `$.session.usage`, `$.fs.read` (its own spool file, to carry `seq` across a hot reload), `$.fs.write`, `$.clock.now` and `$.ui.log` to the debug log.

## Notes for readers of the spool

- `$.fs` has no rename, so a write is not atomic. If a file fails to parse, retry it.
- `seq` grows with every write for a session and carries over a hot reload. It restarts at 1 only if the previous file was torn at the moment of a reload, so compare `writtenAt` before `seq`.
- After `/clear`, `session.end` is written under the old id. The new id gets `session.measure` records with no `session.start`.
- The mod can't set file modes. `$.fs.write` creates missing directories with the default umask, so Signalbox must create the spool directory as 0700 itself.

## Developing

- `bun test plugins/signalbox-tap` runs `test/tap.spec.ts` against a fake `$`.
- `claude plugin test plugins/signalbox-tap` runs `tests/tap.test.ts` in Claude Code's own test host (with `CLAUDE_CONFIG_DIR` pointed at a temporary folder). The root `bunfig.toml` keeps Bun from collecting these engine-native tests.
- To try it, follow `docs/SPIKE.md`: a new throwaway session, the per-session mods folder. Don't add this folder to `CLAUDE_CODE_PLUGIN_DIRS` in your settings.
- Claude Code lays its generated API types in `.claude-plugin/types/` when it loads the mod. That folder is gitignored and must not be committed.
