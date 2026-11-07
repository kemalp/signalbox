// Loaded before every `bun test` file (bunfig.toml): tests never depend on this machine's Claude Code managed settings.
// Tests that spawn the CLI with their own env set SIGNALBOX_CLAUDE_MANAGED_SETTINGS_DIR there too.
process.env.SIGNALBOX_CLAUDE_MANAGED_SETTINGS_DIR ??= "";
