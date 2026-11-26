import { describe, expect, it } from "vitest";
import { droppedEnvLine, handoffEnv, secretEnvName } from "../src/daemon/handoff-env";

/** The environment a handoff's agent starts with (SPEC §31): no variable whose name says its value is a secret. */

describe("which environment variable names say \"secret\"", () => {
  it("tokens, passwords, keys and credentials do", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "STRIPE_KEY",
      "DATABASE_PASSWORD",
      "MYSQL_PWD",
      "PGPASSWORD",
      "GHTOKEN",
      "SENTRY_DSN",
      "GITHUB_PAT",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "REDISCLI_AUTH",
      "SESSION_COOKIE",
      "WORKMESH_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "apiKey",
      "client_secret",
    ]) {
      expect(secretEnvName(name), name).toBe(true);
    }
  });

  it("the tool chain, the shell and the session do not", () => {
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "LANG",
      "TMPDIR",
      "PWD",
      "OLDPWD",
      "NVM_DIR",
      "JAVA_HOME",
      "GOPATH",
      "CARGO_HOME",
      "PYENV_ROOT",
      "VOLTA_HOME",
      "BUN_INSTALL",
      "SSH_AUTH_SOCK",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GPG_TTY",
      "KUBECONFIG",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "TERM_SESSION_ID",
      "SECURITYSESSIONID",
      "INIT_CWD",
      "PASSWORD_STORE_DIR",
      "SSH_KEY_PATH",
      // The last word decides: a path to a token is not the token.
      "GITHUB_TOKEN_FILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "MAX_TOKENS",
      "TOKEN_COUNT",
      "CLAUDE_CODE_USE_BEDROCK",
      "WORKMESH_HANDOFF",
    ]) {
      expect(secretEnvName(name), name).toBe(false);
    }
  });
});

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
    UNSET: undefined,
  };
  const names = (env: NodeJS.ProcessEnv) => Object.keys(env).sort();
  const toolChain = ["AWS_ACCESS_KEY_ID", "HOME", "JAVA_HOME", "NVM_DIR", "PATH", "PWD", "SSH_AUTH_SOCK"];

  it("Claude Code: its own sign-in stays, every other secret-looking name goes, the tool chain passes", () => {
    const r = handoffEnv(base, "claude");
    expect(names(r.env)).toEqual([...toolChain, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].sort());
    expect(r.dropped).toEqual([
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "PGPASSWORD",
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
    // Off, or a Codex run: no cloud credentials.
    for (const off of ["", "0", "false"]) expect(handoffEnv({ ...base, CLAUDE_CODE_USE_BEDROCK: off }, "claude").dropped, off).toContain("AWS_SECRET_ACCESS_KEY");
    expect(handoffEnv({ ...base, CLAUDE_CODE_USE_BEDROCK: "1" }, "codex").dropped).toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("names the person listed are kept; a listed name that isn't set adds nothing", () => {
    const r = handoffEnv(base, "claude", ["GITHUB_TOKEN", "NOT_SET_TOKEN"]);
    expect(r.env.GITHUB_TOKEN).toBe("v-github");
    expect(r.dropped).not.toContain("GITHUB_TOKEN");
    expect("NOT_SET_TOKEN" in r.env).toBe(false);
    expect(r.dropped).toContain("NPM_TOKEN");
  });

  it("the log line names what was dropped and never a value", () => {
    const r = handoffEnv(base, "claude");
    const line = droppedEnvLine(r.dropped);
    expect(line).toBe(
      "workmesh: 9 environment variables were not passed to the agent, because the name looks like a secret: " +
        "AWS_BEARER_TOKEN_BEDROCK, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, GITHUB_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, NPM_TOKEN, OPENAI_API_KEY, PGPASSWORD, STRIPE_KEY. " +
        "To pass one, add its name to handoffs.env in the Workmesh config.",
    );
    for (const value of Object.values(base)) if (value) expect(line.includes(value), value).toBe(false);
    expect(droppedEnvLine(["NPM_TOKEN"])).toMatch(/^workmesh: 1 environment variable was not passed/);
    const many = Array.from({ length: 230 }, (_, i) => `SECRET_${i}_TOKEN`);
    expect(droppedEnvLine(many)).toMatch(/SECRET_199_TOKEN and 30 more\. To pass one/);
  });
});
