// Runs before every test file (vitest.config.ts setupFiles). Agent config dirs
// come from these variables before HOME, so a developer running the suite from
// inside Claude Code or Codex must not have their real settings edited.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
