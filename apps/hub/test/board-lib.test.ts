import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "../src/board/lib/markdown";
import { buildTranscript, foldLabel, turnDuration } from "../src/board/lib/transcript";
import type { HubEvent } from "../src/shared/types";

describe("markdown subset", () => {
  it("parses code spans, bold, italics and links, leaving underscores in names alone", () => {
    expect(parseInline("Run `pnpm test` in **workmesh** and see [PR 41](https://github.com/b3-fun/workmesh/pull/41); keep test_helpers.py and *that*")).toEqual([
      { t: "text", v: "Run " },
      { t: "code", v: "pnpm test" },
      { t: "text", v: " in " },
      { t: "strong", c: [{ t: "text", v: "workmesh" }] },
      { t: "text", v: " and see " },
      { t: "link", href: "https://github.com/b3-fun/workmesh/pull/41", c: [{ t: "text", v: "PR 41" }] },
      { t: "text", v: "; keep test_helpers.py and " },
      { t: "em", c: [{ t: "text", v: "that" }] },
    ]);
  });

  it("never yields markup or unsafe links: HTML stays text, javascript: and relative links stay text", () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [rel](/api/state) <script>x</script>');
    expect(JSON.stringify(blocks)).not.toContain('"t":"link"');
    expect(blocks[0]).toEqual({ t: "p", c: [{ t: "text", v: "<img src=x onerror=alert(1)> click rel <script>x</script>" }] });
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("https://linear.app/npclabs/issue/B3-7166")).toBe("https://linear.app/npclabs/issue/B3-7166");
  });

  it("autolinks bare URLs without trailing punctuation", () => {
    expect(parseInline("see https://workmesh.b3os.org/pair?code=ABCD-1234.")).toEqual([
      { t: "text", v: "see " },
      { t: "link", href: "https://workmesh.b3os.org/pair?code=ABCD-1234", c: [{ t: "text", v: "https://workmesh.b3os.org/pair?code=ABCD-1234" }] },
      { t: "text", v: "." },
    ]);
  });

  it("parses blocks: paragraphs, headings, fenced code, nested lists, quotes and tables", () => {
    const src = [
      "## Plan",
      "First line",
      "continues here.",
      "",
      "```ts",
      "const a = 1;",
      "",
      "```",
      "- one",
      "  - nested",
      "- two",
      "  wraps",
      "1. first",
      "2. second",
      "> quoted",
      "",
      "| Field | Type |",
      "|---|---|",
      "| `text` | string |",
    ].join("\n");
    const b = parseMarkdown(src);
    expect(b.map((x) => x.t)).toEqual(["h", "p", "code", "list", "list", "quote", "table"]);
    expect(b[1]).toEqual({ t: "p", c: [{ t: "text", v: "First line continues here." }] });
    expect(b[2]).toEqual({ t: "code", lang: "ts", v: "const a = 1;\n" });
    const ul = b[3] as Extract<(typeof b)[number], { t: "list" }>;
    expect(ul.items.map((i) => i.level)).toEqual([0, 1, 0]);
    expect(ul.items[2]!.c).toEqual([{ t: "text", v: "two wraps" }]);
    const table = b[6] as Extract<(typeof b)[number], { t: "table" }>;
    expect(table.rows[0]![0]).toEqual([{ t: "code", v: "text" }]);
  });

  it("an unclosed fence runs to the end", () => {
    expect(parseMarkdown("```\nnever closed")).toEqual([{ t: "code", lang: "", v: "never closed" }]);
  });
});

let i = 0;
const ev = (over: Partial<HubEvent>): HubEvent => ({
  deviceId: "dev_A",
  id: `e${++i}`,
  hubKey: "dev_A:claude-code:s",
  email: "sean@example.com",
  ts: i,
  kind: "tool",
  tool: null,
  label: null,
  path: null,
  cmd: null,
  repo: null,
  branch: null,
  issues: [],
  pr: null,
  ok: null,
  text: null,
  truncated: false,
  desc: null,
  durationMs: null,
  summary: null,
  ...over,
});

describe("transcript", () => {
  it("folds consecutive tool calls into one line, like Claude Code", () => {
    expect(
      foldLabel([
        ev({ tool: "Bash", cmd: "pnpm test" }),
        ev({ tool: "Edit", path: "a.ts" }),
        ev({ tool: "Edit", path: "a.ts" }),
        ev({ tool: "Write", path: "b.ts" }),
        ev({ tool: "Bash" }),
        ev({ tool: "mcp__claude-in-chrome__navigate" }),
        ev({ tool: "mcp__claude-in-chrome__computer" }),
        ev({ tool: "Read", path: "c.ts" }),
        ev({ tool: "WebSearch" }),
        ev({ tool: "Frobnicate" }),
      ]),
    ).toBe("Ran 2 shell commands · Edited 2 files · Called claude-in-chrome 2 times · Read 1 file · Searched the web once · Called Frobnicate once");
  });

  it("builds prompt, message, tool group, wait and turn items, skipping idle", () => {
    const items = buildTranscript([
      ev({ kind: "start" }),
      ev({ kind: "prompt", text: "Ship it" }),
      ev({ kind: "message", text: "On it." }),
      ev({ tool: "Bash", ok: false }),
      ev({ tool: "Bash", ok: true }),
      ev({ kind: "waiting", label: "approve plan" }),
      ev({ kind: "idle" }),
      ev({ tool: "Edit", path: "x.ts" }),
      ev({ kind: "turn", durationMs: 94_000 }),
    ]);
    expect(items.map((x) => x.k)).toEqual(["mark", "prompt", "message", "tools", "waiting", "tools", "turn"]);
    const tools = items[3] as Extract<(typeof items)[number], { k: "tools" }>;
    expect(tools).toMatchObject({ label: "Ran 2 shell commands", failed: 1 });
    expect(turnDuration(94_000)).toBe("1m 34s");
    expect(turnDuration(3_725_000)).toBe("1h 02m");
  });
});
