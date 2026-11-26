import { nameStrength, nameWords } from "../hub/redact";

/**
 * The environment a handoff's agent starts with (docs/SPEC.md §31). The daemon's own environment can carry secrets:
 * one started from a shell has that shell's tokens and keys. The agent works on someone else's task, so it gets the
 * daemon's environment without the variables whose NAME says the value is a secret. What its own tool signs in with
 * is kept, and so is every name the person lists (`handoffs.env`). Values are never read here, and never logged.
 */

export type HandoffAgentName = "claude" | "codex";

/** What each agent tool signs in with. */
const SIGN_IN: Record<HandoffAgentName, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
};

/** The cloud credentials Claude Code signs in with when it is told to use that provider. */
const CLAUDE_PROVIDERS: ReadonlyArray<{ flag: string; names: readonly string[] }> = [
  { flag: "CLAUDE_CODE_USE_BEDROCK", names: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"] },
  { flag: "CLAUDE_CODE_USE_VERTEX", names: ["GOOGLE_APPLICATION_CREDENTIALS"] },
];

/** The working directory and the one before it. `PWD` reads as "password" to a name classifier. */
const NEVER_SECRET = new Set(["PWD", "OLDPWD"]);

/** A secret word at the end of a name's last word, with nothing to split it off: `PGPASSWORD`, `GHTOKEN`. */
const GLUED_SECRET = /(?:password|passwd|secret|token|apikey)$/;

/**
 * Secrets whose name ends in another word. The classifier reads a name's last word, so it misses them, and they are
 * listed here by name. Only names this file also keeps for a provider are listed: a rule for "a secret word anywhere"
 * would drop `AWS_WEB_IDENTITY_TOKEN_FILE` and `PASSWORD_STORE_DIR`, which are paths.
 */
const ALSO_SECRET = new Set(["AWS_BEARER_TOKEN_BEDROCK"]);

/** How many dropped names the run's log lists before it only counts the rest. */
const LISTED_MAX = 200;

/**
 * Whether an environment variable's name says its value is a secret. It is the redaction rules' reading of a name
 * (hub/redact.ts), which goes by the name's last word: `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` and `STRIPE_KEY` are
 * secrets; `PATH`, `NVM_DIR`, `SSH_AUTH_SOCK`, `GIT_ASKPASS` and `GITHUB_TOKEN_FILE` are not.
 */
export function secretEnvName(name: string): boolean {
  if (NEVER_SECRET.has(name)) return false;
  if (ALSO_SECRET.has(name) || nameStrength(name) !== undefined) return true;
  return GLUED_SECRET.test(nameWords(name).at(-1) ?? "");
}

const isOn = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

export interface HandoffEnv {
  env: NodeJS.ProcessEnv;
  /** The names that were not passed on, sorted. Never their values. */
  dropped: string[];
}

/** `base` without the variables whose names say "secret", except the agent tool's own sign-in and `keep`. */
export function handoffEnv(base: NodeJS.ProcessEnv, agent: HandoffAgentName, keep: readonly string[] = []): HandoffEnv {
  const kept = new Set<string>([...SIGN_IN[agent], ...keep]);
  if (agent === "claude") {
    for (const p of CLAUDE_PROVIDERS) if (isOn(base[p.flag])) for (const n of p.names) kept.add(n);
  }
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!kept.has(name) && secretEnvName(name)) dropped.push(name);
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
    `because the name looks like a secret: ${listed}${more}. To pass one, add its name to handoffs.env in the Workmesh config.`
  );
}
