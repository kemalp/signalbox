# Gemini CLI / Antigravity: scouting notes

These notes are for a future `adapter-gemini`. Nothing is implemented yet. They come from scouting `~/.gemini` on this machine on 2026-10-09: directory and file names, JSON key names and SQLite schemas only. No file with `token`, `oauth`, `credential` or `auth` in its name was opened, and no conversation content was read.

## What is on disk here

Top level of `~/.gemini`:

| Entry | What it is | Notes |
|---|---|---|
| `settings.json` | Gemini CLI user settings | Only key here: `context.fileName`. Telemetry is not configured |
| `GEMINI.md` | global context file | content, never read |
| `projects.json` | project registry | key `projects`. About 45 leftover `projects.json.<uuid>.tmp` files sit beside it (a writer that never cleans up) |
| `tmp/<project>/` | Gemini CLI per-project scratch: chats, checkpoints, logs | only `tmp/scratchpad/.project_root` exists. **No chat recordings on this machine** |
| `history/<project>/` | shadow git repo for file checkpoints (`/restore`) | only `history/scratchpad/.project_root` |
| `config/` | Antigravity: `config.json`, `mcp_config.json`, `plugins/`, `projects/<uuid>.json`, `outside-of-project.json`, `sidecars/`, `node_modules/sidecar_sdk` | |
| `antigravity/` | Antigravity agent state (below) | most of the data |
| `antigravity-ide/`, `antigravity-backup/` | same layout as `antigravity/`, mostly empty: `brain/`, `code_tracker/`, `context_state/`, `knowledge/`, `mcp_config.json`, `installation_id` | |
| `jetski-standalone-oauth-token` | credential | **never open**. Matches the forbidden-name rule |

`~/.gemini/antigravity/`:

- `conversations/<uuid>.db`: one SQLite database per conversation (16 here). Tables: `trajectory_meta (trajectory_id, cascade_id, trajectory_type, source)`, `steps (idx, step_type, status, has_subtrajectory, metadata, error_details, permissions, task_details, render_info, step_payload, step_format)`, `gen_metadata (idx, data, size)`, `executor_metadata`, `parent_references`, `trajectory_metadata_blob`, `battle_mode_infos`. The payload columns are **protobuf blobs**. Per-generation model and usage figures probably live in `gen_metadata.data` or `steps.metadata`. That is unverified: the blobs were not decoded, because they sit next to content.
- `conversation_summaries.db` (one table, `conversation_summaries`), `agyhub_summaries_proto.pb`, `antigravity_state.pbtxt`, `annotations/<uuid>.pbtxt`.
- `brain/<uuid>/`: per-conversation artifacts (plans, task lists, walkthroughs, uploads, scratch). This is content and stays off limits.
- `code_tracker/`, `context_state/`, `knowledge/`, `mcp/`, `builtin/skills/`, `bin/`, `lib/`, `crashes/`, `scratch/`.

There are also `~/.antigravity/` and `~/Library/Application Support/Antigravity/` (the IDE). Neither was scouted.

## What the official Gemini CLI docs say

Sessions ([Session management](https://geminicli.com/docs/cli/session-management/)):

- Chats are saved automatically under `~/.gemini/tmp/<project_hash>/chats/`. The hash is derived from the project root, and history is per project.
- A recording holds the conversation, tool calls, **token usage statistics** (input, output, cached) and thought summaries. Retention defaults to 30 days, and `gemini -r` resumes.
- File checkpoints live in a shadow git repo at `~/.gemini/history/<project_hash>`, per the [Checkpointing](https://geminicli.com/docs/cli/checkpointing/) docs.
- Cached-token figures appear only for Gemini API key or Vertex AI users, not for Google-account (OAuth) users. `/stats` shows totals.

Telemetry ([telemetry.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md)) is OpenTelemetry and off by default. The `settings.json` `telemetry.*` keys each have an env override:

| Setting | Env | Default |
|---|---|---|
| `enabled` | `GEMINI_TELEMETRY_ENABLED` | `false` |
| `target` (`local` \| `gcp`) | `GEMINI_TELEMETRY_TARGET` | `local` |
| `otlpEndpoint` | `GEMINI_TELEMETRY_OTLP_ENDPOINT` | `http://localhost:4317` |
| `otlpProtocol` (`grpc` \| `http`) | `GEMINI_TELEMETRY_OTLP_PROTOCOL` | `grpc` |
| `outfile` (overrides the endpoint) | `GEMINI_TELEMETRY_OUTFILE` | none |
| `logPrompts` | `GEMINI_TELEMETRY_LOG_PROMPTS` | `true` |
| `useCollector` | `GEMINI_TELEMETRY_USE_COLLECTOR` | `false` |

- **Per-request usage:** log event `gemini_cli.api_response`, with `model`, `duration_ms`, `input_token_count`, `output_token_count`, `cached_content_token_count`, `thoughts_token_count`, `tool_token_count`, `total_token_count`, `prompt_id`, `status_code`, `auth_type`, `finish_reasons`, and an optional `response_text`. `session.id` is a common attribute.
- **Metric:** `gemini_cli.token.usage`, with attributes `model` and `type` ∈ `input | output | thought | cache | tool`.

## Recommendation for an adapter

1. **Primary: chat recordings** in `~/.gemini/tmp/<project_hash>/chats/*.json` (stability *internal*). They record per-message token counts and the model, which gives full history without any setup. The exact JSON shape has to be verified on a machine that has recordings; this one has none. Questions to settle then: a stable per-response id for dedup, whether `input` includes `cached`, and whether `thoughts` is inside or beside `output`. My understanding of the Gemini API's `usageMetadata`, not checked against a source this session, is that `promptTokenCount` includes `cachedContentTokenCount` and `candidatesTokenCount` excludes `thoughtsTokenCount`. If so, `input = prompt - cached` and `output = candidates + thoughts`. Confirm against the API reference before relying on it.
2. **Exact, opt-in: OTLP.** The user sets `GEMINI_TELEMETRY_ENABLED=true`, `GEMINI_TELEMETRY_OTLP_PROTOCOL=http`, `GEMINI_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:4318` and `GEMINI_TELEMETRY_LOG_PROMPTS=false` in their shell. Signalbox already plans an OTLP receiver on 4318 for Claude Code. Signalbox must not write `settings.json`, so this is a documented step the user takes. `outfile` is a file-based alternative, but its format isn't specified in the docs.
3. **Antigravity: not yet.** The data is protobuf inside per-conversation SQLite, undocumented and binary, so it would be *internal* at best and needs schema reverse-engineering. Revisit if Google documents an export or a usage surface.
4. **Never:** `jetski-standalone-oauth-token`, any `oauth_creds.json` or `google_accounts.json`, the `brain/` artifacts, and `GEMINI.md` content.

Unverified: a third-party cheat sheet says the hosted Gemini CLI was retired for consumer plans on 2026-06-18 in favour of an "Antigravity CLI". This could not be confirmed on Google's own pages. If it is true, Antigravity's on-disk format matters more than the Gemini CLI chat format.
