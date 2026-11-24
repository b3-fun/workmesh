import { describe, expect, it } from "vitest";
import { resolveRelayUrl } from "../src/commands/setup";

describe("resolveRelayUrl", () => {
  it("accepts hosted and self-hosted https urls", () => {
    expect(resolveRelayUrl("https://agentblip.com")).toBe("https://agentblip.com");
    expect(resolveRelayUrl("  https://relay.corp.example  ")).toBe(
      "https://relay.corp.example",
    );
    expect(resolveRelayUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("rejects garbage and non-http protocols", () => {
    expect(() => resolveRelayUrl("")).toThrow(/invalid relay URL/);
    expect(() => resolveRelayUrl("not a url")).toThrow(/invalid relay URL/);
    expect(() => resolveRelayUrl("ftp://example.com")).toThrow(/must be http/);
  });
});

describe("setup --hooks-only", () => {
  it("installs Claude Code and Codex hooks without touching config or other tools' hooks", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { vi } = await import("vitest");
    const { installHooksOnly } = await import("../src/commands/setup");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-hooksonly-"));
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, XDG: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    delete process.env.CODEX_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(home, ".codex"));
      const other = { hooks: { Stop: [{ hooks: [{ type: "command", command: "'/x/node' '/x/notify.mjs'", timeout: 5 }] }] } };
      fs.writeFileSync(path.join(home, ".codex", "hooks.json"), JSON.stringify(other));
      const toml = 'notify = ["/x/Client", "turn-ended", "--previous-notify", "[\\"node\\",\\"/x/agentblip/dist/index.js\\",\\"hook\\",\\"codex\\"]"]\n';
      fs.writeFileSync(path.join(home, ".codex", "config.toml"), toml);

      installHooksOnly();

      const hooks = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(hooks.hooks.Stop?.[0]).toEqual(other.hooks.Stop[0]);
      expect(hooks.hooks.Stop?.some((e) => e.hooks[0]?.command.includes("hook codex-hooks"))).toBe(true);
      expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toBe(toml);
      const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) as { hooks: object };
      expect(Object.keys(claude.hooks)).toContain("PreToolUse");
      expect(fs.existsSync(path.join(home, ".config", "agentblip", "config.json"))).toBe(false);
    } finally {
      log.mockRestore();
      process.env.HOME = saved.HOME;
      if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.CODEX_HOME;
      if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.XDG;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
