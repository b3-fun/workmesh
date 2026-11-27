import { describe, expect, it } from "vitest";
import { droppedEnvLine, handoffEnv } from "../src/daemon/handoff-env";

describe("the environment a handoff's agent gets", () => {
  const base = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/sam",
    PWD: "/home/sam/code",
    NVM_DIR: "/home/sam/.nvm",
    JAVA_HOME: "/opt/jdk",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GITHUB_TOKEN: "v-github",
    NPM_TOKEN: "v-npm",
    PGPASSWORD: "v-pg",
    STRIPE_KEY: "v-stripe",
    ANTHROPIC_API_KEY: "v-anthropic",
    ANTHROPIC_AUTH_TOKEN: "v-anthropic-auth",
    CLAUDE_CODE_OAUTH_TOKEN: "v-oauth",
    OPENAI_API_KEY: "v-openai",
    AWS_ACCESS_KEY_ID: "v-aws-id",
    AWS_SECRET_ACCESS_KEY: "v-aws-secret",
    AWS_SESSION_TOKEN: "v-aws-session",
    AWS_BEARER_TOKEN_BEDROCK: "v-bedrock",
    GOOGLE_APPLICATION_CREDENTIALS: "/home/sam/adc.json",
    ANTHROPIC_FOUNDRY_API_KEY: "v-foundry",
    UNSET: undefined,
  };
  const names = (env: NodeJS.ProcessEnv) => Object.keys(env).sort();
  const toolChain = ["HOME", "JAVA_HOME", "NVM_DIR", "PATH", "PWD"];

  it("Claude Code: its own sign-in stays, every other secret-looking name goes, the tool chain passes", () => {
    const r = handoffEnv(base, "claude");
    expect(names(r.env)).toEqual([...toolChain, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].sort());
    expect(r.dropped).toEqual([
      "ANTHROPIC_FOUNDRY_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "PGPASSWORD",
      "SSH_AUTH_SOCK",
      "STRIPE_KEY",
    ]);
    expect(r.env.PATH).toBe("/usr/bin:/bin");
    expect(r.env.ANTHROPIC_API_KEY).toBe("v-anthropic");
  });

  it("Codex: its key stays, Claude Code's sign-in goes", () => {
    const r = handoffEnv(base, "codex");
    expect(names(r.env)).toEqual([...toolChain, "OPENAI_API_KEY"].sort());
    expect(r.dropped).toContain("ANTHROPIC_API_KEY");
    expect(r.dropped).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("Claude Code on a cloud provider keeps that provider's credentials, and only then", () => {
    const bedrock = handoffEnv({ ...base, CLAUDE_CODE_USE_BEDROCK: "1" }, "claude");
    for (const n of ["AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) expect(bedrock.env[n], n).toBeDefined();
    expect(bedrock.dropped).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    const vertex = handoffEnv({ ...base, CLAUDE_CODE_USE_VERTEX: "true" }, "claude");
    expect(vertex.env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/home/sam/adc.json");
    expect(vertex.dropped).toContain("AWS_SECRET_ACCESS_KEY");
    const foundry = handoffEnv({ ...base, CLAUDE_CODE_USE_FOUNDRY: "1" }, "claude");
    expect(foundry.env.ANTHROPIC_FOUNDRY_API_KEY).toBe("v-foundry");
    expect(foundry.dropped).not.toContain("ANTHROPIC_FOUNDRY_API_KEY");
    expect(foundry.dropped).toContain("AWS_SECRET_ACCESS_KEY");
    expect(foundry.dropped).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    // Without the switch, or for the other providers, the Foundry key goes like any other secret-looking name.
    for (const r of [bedrock, vertex, handoffEnv({ ...base, CLAUDE_CODE_USE_FOUNDRY: "0" }, "claude")]) expect(r.dropped).toContain("ANTHROPIC_FOUNDRY_API_KEY");
    // Off, or a Codex run: no cloud credentials.
    for (const off of ["", "0", "false"]) expect(handoffEnv({ ...base, CLAUDE_CODE_USE_BEDROCK: off }, "claude").dropped, off).toContain("AWS_SECRET_ACCESS_KEY");
    expect(handoffEnv({ ...base, CLAUDE_CODE_USE_BEDROCK: "1" }, "codex").dropped).toContain("AWS_SECRET_ACCESS_KEY");
    expect(handoffEnv({ ...base, CLAUDE_CODE_USE_FOUNDRY: "1" }, "codex").dropped).toContain("ANTHROPIC_FOUNDRY_API_KEY");
  });

  it("retains the selected agent's configured profile and endpoint", () => {
    const env = { CODEX_HOME: "/tmp/codex", OPENAI_BASE_URL: "https://openai.example", CLAUDE_CONFIG_DIR: "/tmp/claude", ANTHROPIC_BASE_URL: "https://claude.example" };
    expect(handoffEnv(env, "codex").env).toEqual({ CODEX_HOME: env.CODEX_HOME, OPENAI_BASE_URL: env.OPENAI_BASE_URL });
    expect(handoffEnv(env, "claude").env).toEqual({ CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL });
  });

  it("names the person listed are kept; a listed name that isn't set adds nothing", () => {
    const r = handoffEnv(base, "claude", ["GITHUB_TOKEN", "NOT_SET_TOKEN"]);
    expect(r.env.GITHUB_TOKEN).toBe("v-github");
    expect(r.dropped).not.toContain("GITHUB_TOKEN");
    expect("NOT_SET_TOKEN" in r.env).toBe(false);
    expect(r.dropped).toContain("NPM_TOKEN");
  });

  it("allows only named runtime settings, agent sign-in and explicit opt-ins", () => {
    const env = { LANG: "C", LC_TIME: "C", SSH_AUTH_SOCK: "sock", OPAQUE_CONFIG: "value", GIT_ASKPASS: "helper", NODE_OPTIONS: "opts" };
    expect(handoffEnv(env, "codex").env).toEqual({ LANG: "C", LC_TIME: "C" });
    expect(handoffEnv(env, "codex", ["SSH_AUTH_SOCK"]).env.SSH_AUTH_SOCK).toBe("sock");
  });

  it("the log line names what was dropped and never a value", () => {
    const r = handoffEnv(base, "claude");
    const line = droppedEnvLine(r.dropped);
    expect(line).toBe(
      "workmesh: 12 environment variables were not passed to the agent, because they are outside the handoff environment: " +
        "ANTHROPIC_FOUNDRY_API_KEY, AWS_ACCESS_KEY_ID, AWS_BEARER_TOKEN_BEDROCK, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, GITHUB_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, NPM_TOKEN, OPENAI_API_KEY, PGPASSWORD, SSH_AUTH_SOCK, STRIPE_KEY. " +
        "To pass one, add its name to handoffs.env in the Workmesh config.",
    );
    for (const value of Object.values(base)) if (value) expect(line.includes(value), value).toBe(false);
    expect(droppedEnvLine(["NPM_TOKEN"])).toMatch(/^workmesh: 1 environment variable was not passed/);
    const many = Array.from({ length: 230 }, (_, i) => `SECRET_${i}_TOKEN`);
    expect(droppedEnvLine(many)).toMatch(/SECRET_199_TOKEN and 30 more\. To pass one/);
  });
});
