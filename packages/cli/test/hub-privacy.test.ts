import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore, hubIngestRequestSchema } from "@workmesh/core";
import type { HubIngestRequest, HubProjectRule, HubShareLevel, SessionEvent } from "@workmesh/core";
import { mapHookInput } from "../src/adapters/claude-code";
import { mapCodexHookInput } from "../src/adapters/codex";
import { HubForwarder } from "../src/hub/forwarder";
import { PEM, PEM_BODY, SECRETS, SLACK_WEBHOOK_SECRET } from "./fixtures/fake-secrets";
import { claudeLines as cl, codexLines as cx } from "./fixtures/transcripts";

/**
 * The privacy test SPEC §9 asks for: realistic secrets in prompts, agent
 * messages, tool descriptions and every kind of transcript line go through
 * the real hook mappers, the transcript tailer, redaction and the forwarder;
 * nothing of them may be in any request body.
 */

const NOW = 1_795_545_600_000;
const RULE: HubProjectRule = { id: "b3", name: "B3", include: { remotes: ["github.com/b3-fun/"], dirs: [] }, issueKeys: ["B3"] };

let home: string;
let repo: string;
let projects: string;
beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-privacy-")));
  repo = path.join(home, "Documents", "b3", "b3os-beta");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:b3-fun/b3os-beta.git\n');
  projects = path.join(home, ".claude", "projects", "-repo");
  fs.mkdirSync(projects, { recursive: true });
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Text that must never leave in any form: values only, not their (public) prefixes. */
function forbidden(): string[] {
  const s = SECRETS;
  return [
    s.anthropic.slice(14),
    s.openai.slice(8),
    s.openaiLegacy.slice(3),
    s.openrouter.slice(9),
    s.stripe.slice(8),
    s.ghp.slice(4),
    s.gho.slice(4),
    s.ghs.slice(4),
    s.githubPat.slice(11),
    s.slackBot.slice(5),
    s.slackUser.slice(5),
    s.awsId.slice(4),
    s.awsSecret,
    s.npm.slice(4),
    s.linear.slice(8),
    s.bullpen.slice(3),
    s.relayDevice.slice(3),
    s.google.slice(4),
    s.hf.slice(3),
    s.jwt.split(".")[1]!,
    s.jwt.split(".")[2]!,
    s.cloudflare,
    s.databento.slice(3),
    s.password,
    s.pgPassword,
    SLACK_WEBHOOK_SECRET,
    s.evmKey,
    PEM_BODY,
    "QyNTUxOQAAACBzZWNyZXRr",
  ];
}

/** Content that is never text to share, whatever its form: thinking, tool input/output, file contents. */
const NEVER = ["THINKING_MARKER", "TOOL_INPUT_MARKER", "TOOL_OUTPUT_MARKER", "FILE_CONTENTS_MARKER", "API_COPY_MARKER", "ATTACHMENT_MARKER", "EARLIER_MARKER"];

function run(share: HubShareLevel) {
  const store = new SessionStore();
  const raw: string[] = [];
  let now = NOW;
  const fwd = new HubForwarder({
    url: "https://hub.test",
    token: SECRETS.bullpen,
    rule: RULE,
    listSessions: () => store.list(),
    getSession: (k) => store.get(k),
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
      raw.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 200 });
    }) as typeof fetch,
    now: () => now,
    homeDir: home,
    share,
    codexSessionsDir: path.join(home, ".codex", "sessions"),
    turnRecordWaitMs: 0,
  });
  const feed = (e: SessionEvent | null): void => {
    if (!e) throw new Error("mapper returned null");
    store.apply(e, now);
    fwd.observe(e);
    now += 100;
  };
  const s = SECRETS;
  const t = path.join(projects, `privacy-${share}.jsonl`);
  fs.writeFileSync(t, `${cl.text(`EARLIER_MARKER ${s.anthropic}`, "early", NOW - 1000)}\n`);
  const append = (...lines: string[]): void => fs.appendFileSync(t, lines.map((l) => `${l}\n`).join(""));
  const claude = (input: Record<string, unknown>): void =>
    feed(mapHookInput({ session_id: "p1", cwd: repo, transcript_path: t, ...input }, now, { backgroundWork: () => false, turnEnding: () => "done" }));

  // --- Claude Code: prompts with secrets ---
  claude({ hook_event_name: "SessionStart" });
  claude({
    hook_event_name: "UserPromptSubmit",
    prompt: [
      `Deploy with ANTHROPIC_API_KEY=${s.anthropic} and OPENAI_API_KEY="${s.openai}".`,
      `The db is postgres://admin:${s.pgPassword}@db.internal:5432/app, password is ${s.pgPassword}.`,
      `Use my GitHub token ${s.ghp} (and ${s.githubPat}), npm ${s.npm}, Linear ${s.linear}.`,
      `curl -H "Authorization: Bearer ${s.bullpen}" https://bullpen.b3os.org/relay/ingest`,
      `export AWS_ACCESS_KEY_ID=${s.awsId} AWS_SECRET_ACCESS_KEY=${s.awsSecret}`,
      `Here is the deploy key:\n${PEM}`,
      `Files are in ${home}/Documents/b3 and my password hunter2 for B3-7166.`,
    ].join("\n"),
  });
  // --- agent messages with secrets, plus lines that must never be read ---
  append(
    cl.thinking(`THINKING_MARKER ${s.openrouter}`),
    cl.text(`I'll set SLACK_BOT_TOKEN=${s.slackBot} and the webhook ${s.slackWebhook}. The JWT is ${s.jwt}.`, "a1", now),
    cl.toolUse("Bash", { command: `TOOL_INPUT_MARKER gh auth login --with-token <<< ${s.gho}`, description: "Log in to GitHub" }),
  );
  claude({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `gh auth login --with-token <<< ${s.gho}`, description: `Log in with ${s.gho}` } });
  append(cl.toolResult(`TOOL_OUTPUT_MARKER logged in as sean, token ${s.ghs}`), cl.apiBlob(`API_COPY_MARKER ${s.stripe}`), cl.attachment(now));
  claude({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: `gh auth login --with-token <<< ${s.gho}` },
    tool_response: { stdout: `TOOL_OUTPUT_MARKER ${s.ghs}`, stderr: "" },
  });
  claude({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: { query: `why does ${s.google} return 403` } });
  claude({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: `https://api.example.com/v1/keys?api_key=${s.cloudflare}` } });
  claude({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: `Rotate ${s.hf} and ${s.databento}`, prompt: `TOOL_INPUT_MARKER ${s.hf}` } });
  claude({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(repo, ".env"), old_string: "FILE_CONTENTS_MARKER", new_string: `STRIPE=${s.stripe}` },
  });
  append(
    cl.text(
      [
        `Done. Stored PRIVATE_KEY=0x${s.evmKey} in the vault; relay token ${s.relayDevice}.`,
        `Cloudflare token: ${s.cloudflare}, xoxp ${s.slackUser}, legacy key ${s.openaiLegacy}.`,
        `Notes are in ${home}/Documents/notes.md.`,
      ].join("\n"),
      "a2",
      now,
    ),
    cl.text(`SIDECHAIN ${s.cloudflare}`, "side", now, { isSidechain: true }),
  );
  claude({ hook_event_name: "Stop", last_assistant_message: `Done ${s.cloudflare}` });
  append(cl.turnDuration(12_345, now));

  // --- Codex: prompt, rollout messages, tool calls, Stop fallback ---
  const id = "019ab5c2-4000-7000-8000-00000000f00d";
  const rollout = path.join(home, ".codex", "sessions", `rollout-x-${id}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, "");
  const codex = (input: Record<string, unknown>): void =>
    feed(mapCodexHookInput({ session_id: id, cwd: repo, transcript_path: rollout, model: "m", ...input }, now));
  codex({ hook_event_name: "UserPromptSubmit", prompt: `Ship it with npm token ${s.npm} and NPM_TOKEN=${s.npm}` });
  fs.appendFileSync(
    rollout,
    [
      cx.reasoning(),
      cx.functionCall("exec_command", JSON.stringify({ cmd: `TOOL_INPUT_MARKER echo ${s.anthropic}` })),
      cx.functionCallOutput(`TOOL_OUTPUT_MARKER ${s.anthropic}`),
      cx.assistant(`Published. Token was ${s.npm}; Slack webhook ${s.slackWebhook}.`, "cm1", now),
      cx.taskComplete(9000, now, `LAST ${s.npm}`),
    ].join("\n") + "\n",
  );
  codex({ hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["bash", "-lc", `npm publish --token ${s.npm}`], justification: `publish with ${s.npm}` } });
  codex({ hook_event_name: "Stop", last_assistant_message: `Published with ${s.npm}` });

  // Codex thread with no rollout file: the Stop fallback path.
  const id2 = "019ab5c2-5000-7000-8000-00000000f11e";
  const codex2 = (input: Record<string, unknown>): void =>
    feed(mapCodexHookInput({ session_id: id2, cwd: repo, transcript_path: null, model: "m", ...input }, now));
  codex2({ hook_event_name: "UserPromptSubmit", prompt: "summarize" });
  codex2({ hook_event_name: "Stop", last_assistant_message: `Summary: key ${s.anthropic}, password: ${s.pgPassword}` });

  return {
    raw,
    async finish(): Promise<void> {
      await fwd.flushTranscripts();
      now += 1000;
      await fwd.tick();
      now += 30_000;
      await fwd.tick();
    },
    bodies: (): HubIngestRequest[] => raw.map((r) => JSON.parse(r) as HubIngestRequest),
  };
}

describe("privacy: a corpus of secrets through the whole pipeline", () => {
  it("conversation level: text flows, no secret survives", async () => {
    const r = run("conversation");
    await r.finish();
    const all = r.raw.join("\n");
    for (const secret of forbidden()) {
      expect(all, `leaked ${secret.slice(0, 6)}…`).not.toContain(secret);
      // no 12-char piece of it either
      for (let i = 0; i + 12 <= secret.length; i += 4) expect(all, `leaked a piece of ${secret.slice(0, 6)}…`).not.toContain(secret.slice(i, i + 12));
    }
    for (const marker of NEVER) expect(all, marker).not.toContain(marker);
    expect(all).not.toContain("SIDECHAIN");
    expect(all).not.toContain(home);
    expect(all).not.toContain("/Users/");
    for (const body of r.bodies()) expect(hubIngestRequestSchema.safeParse(body).success).toBe(true);

    // Not vacuous: the conversation is there, with redactions in place.
    const events = r.bodies().flatMap((b) => b.events);
    const texts = events.flatMap((e) => (e.text ? [e.text] : []));
    expect(texts.some((x) => x.startsWith("Deploy with ANTHROPIC_API_KEY=[redacted]"))).toBe(true);
    expect(texts.some((x) => x.includes("~/Documents/b3"))).toBe(true);
    expect(texts.some((x) => x.startsWith("I'll set SLACK_BOT_TOKEN=[redacted]"))).toBe(true);
    expect(texts.some((x) => x.startsWith("Published. Token was [redacted]"))).toBe(true);
    expect(texts.some((x) => x.startsWith("Summary: key [redacted]"))).toBe(true);
    expect(events.filter((e) => e.kind === "message")).toHaveLength(4);
    // Claude Code from its turn record, Codex from task_complete, the SQLite-only thread prompt → stop.
    expect(events.filter((e) => e.kind === "turn").map((e) => e.durationMs ?? -1).sort((a, b) => a - b)).toEqual([100, 9000, 12_345]);
    const descs = events.flatMap((e) => (e.desc ? [e.desc] : []));
    expect(descs).toEqual(["Log in with [redacted]", "why does [redacted] return 403", "api.example.com", "Rotate [redacted] and [redacted]", "publish with [redacted]"]);
  });

  it("metadata level: the same corpus sends no text at all", async () => {
    const r = run("metadata");
    await r.finish();
    const all = r.raw.join("\n");
    for (const secret of forbidden()) expect(all).not.toContain(secret);
    for (const key of ['"text"', '"desc"', '"truncated"', '"durationMs"', '"kind":"message"', '"kind":"turn"', "Deploy with", "redacted"]) {
      expect(all, key).not.toContain(key);
    }
    expect(r.bodies().every((b) => b.share === "metadata")).toBe(true);
  });
});
