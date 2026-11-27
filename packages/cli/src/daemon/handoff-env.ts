export type HandoffAgentName = "claude" | "codex";

/** What each agent tool signs in with. */
const SIGN_IN: Record<HandoffAgentName, readonly string[]> = {
  claude: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["CODEX_HOME", "OPENAI_BASE_URL", "OPENAI_API_KEY"],
};

/** The cloud credentials Claude Code signs in with when it is told to use that provider. */
const CLAUDE_PROVIDERS: ReadonlyArray<{ flag: string; names: readonly string[] }> = [
  { flag: "CLAUDE_CODE_USE_BEDROCK", names: ["ANTHROPIC_BEDROCK_BASE_URL", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"] },
  { flag: "CLAUDE_CODE_USE_VERTEX", names: ["ANTHROPIC_VERTEX_BASE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"] },
  { flag: "CLAUDE_CODE_USE_FOUNDRY", names: ["ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_RESOURCE"] },
];

/** Ordinary process and toolchain settings a locally launched handoff needs. Credentials and helpers require opt-in. */
const RUNTIME = [
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LANGUAGE", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "TERM", "COLORTERM", "NO_COLOR", "PWD", "NVM_DIR", "JAVA_HOME", "GOPATH", "CARGO_HOME",
  "RUSTUP_HOME", "PYENV_ROOT", "VOLTA_HOME", "BUN_INSTALL",
];

const LISTED_MAX = 200;
const isOn = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

export interface HandoffEnv {
  env: NodeJS.ProcessEnv;
  /** The names that were not passed on, sorted. Never their values. */
  dropped: string[];
}

/** Build from an allowlist so an unrecognized secret name, credential socket or helper stays on the parent. */
export function handoffEnv(base: NodeJS.ProcessEnv, agent: HandoffAgentName, keep: readonly string[] = []): HandoffEnv {
  const kept = new Set<string>([...RUNTIME, ...SIGN_IN[agent], ...keep]);
  if (agent === "claude") {
    for (const provider of CLAUDE_PROVIDERS) {
      if (!isOn(base[provider.flag])) continue;
      kept.add(provider.flag);
      for (const name of provider.names) kept.add(name);
    }
  }
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!kept.has(name) && !/^LC_(?:ALL|COLLATE|CTYPE|MESSAGES|MONETARY|NUMERIC|TIME)$/.test(name)) dropped.push(name);
    else env[name] = value;
  }
  return { env, dropped: dropped.sort() };
}

/** The line a run's log opens with when variables were dropped: their names, so the person can see what to add. */
export function droppedEnvLine(dropped: readonly string[]): string {
  const listed = dropped.slice(0, LISTED_MAX).join(", ");
  const more = dropped.length > LISTED_MAX ? ` and ${dropped.length - LISTED_MAX} more` : "";
  return (
    `workmesh: ${dropped.length} environment variable${dropped.length === 1 ? " was" : "s were"} not passed to the agent, ` +
    `because they are outside the handoff environment: ${listed}${more}. To pass one, add its name to handoffs.env in the Workmesh config.`
  );
}
