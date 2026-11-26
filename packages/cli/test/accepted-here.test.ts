import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCEPTED_HERE_MAX, AcceptedHere } from "../src/daemon/accepted-here";

/** The record of handoffs accepted on this machine (SPEC §31): the relay starts only what is in it. Temp dirs. */

const T = 1_795_545_600_000;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-accepted-here-"));
  file = path.join(dir, "state", "workmesh", "handoffs-accepted.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the record of handoffs accepted on this machine", () => {
  it("keeps each id with when and where, in a 0600 file, and a new daemon reads it back", () => {
    const a = new AcceptedHere(file);
    expect(a.has("h_1")).toBe(false);
    a.add("h_1", "cli", T);
    a.add("h_2", "menubar", T + 1);
    a.add("h_3", "policy", T + 2);
    expect(a.has("h_1")).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const entries = [
      { id: "h_1", at: T, by: "cli" },
      { id: "h_2", at: T + 1, by: "menubar" },
      { id: "h_3", at: T + 2, by: "policy" },
    ];
    // Ids, times and places only: the file never holds a handoff's text.
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(entries);
    expect(new AcceptedHere(file).list()).toEqual(entries);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["handoffs-accepted.json"]);
  });

  it("keeps the hash of what was accepted beside the id; an entry without one is from an older record", () => {
    const hash = "a".repeat(64);
    const a = new AcceptedHere(file);
    a.add("h_1", "cli", T, hash);
    a.add("h_2", "policy", T);
    expect(a.get("h_1")).toEqual({ id: "h_1", at: T, by: "cli", hash });
    expect(a.get("h_2")).toEqual({ id: "h_2", at: T, by: "policy" });
    expect(a.get("h_3")).toBeUndefined();
    const again = new AcceptedHere(file);
    expect(again.list()).toEqual([
      { id: "h_1", at: T, by: "cli", hash },
      { id: "h_2", at: T, by: "policy" },
    ]);
    // An older record, ids only, loads as it is. An entry whose hash isn't a hash is not one to go by.
    fs.writeFileSync(file, JSON.stringify([{ id: "h_old", at: T, by: "menubar" }, { id: "h_bad", at: T, by: "cli", hash: "not-a-hash" }, { id: "h_num", at: T, by: "cli", hash: 7 }]));
    expect(new AcceptedHere(file).list()).toEqual([{ id: "h_old", at: T, by: "menubar" }]);
  });

  it("a file that was made wider is 0600 again after the next change", () => {
    const a = new AcceptedHere(file);
    a.add("h_1", "cli", T);
    fs.chmodSync(file, 0o644);
    a.add("h_2", "cli", T);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("is capped: the oldest ids go first, and an id accepted again counts as new", () => {
    const a = new AcceptedHere(file);
    for (let i = 0; i < ACCEPTED_HERE_MAX; i++) a.add(`h_${i}`, "cli", T + i);
    a.add("h_0", "menubar", T + 9999);
    a.add("h_new", "cli", T + 10_000);
    expect(a.list()).toHaveLength(ACCEPTED_HERE_MAX);
    expect(a.has("h_1")).toBe(false);
    expect(a.has("h_0")).toBe(true);
    expect(a.has("h_new")).toBe(true);
    const again = new AcceptedHere(file);
    expect(again.list()).toHaveLength(ACCEPTED_HERE_MAX);
    expect(again.list().at(-1)).toEqual({ id: "h_new", at: T + 10_000, by: "cli" });
  });

  it("prune drops the ids the hub no longer lists, and keeps the rest", () => {
    const a = new AcceptedHere(file);
    a.add("h_1", "cli", T);
    a.add("h_2", "cli", T);
    a.prune(new Set(["h_2", "h_9"]));
    expect(a.list().map((e) => e.id)).toEqual(["h_2"]);
    expect(new AcceptedHere(file).list().map((e) => e.id)).toEqual(["h_2"]);
    a.prune(new Set());
    expect(new AcceptedHere(file).list()).toEqual([]);
  });

  it("a file that can't be read, and entries that make no sense, count as nothing accepted", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(new AcceptedHere(file).list()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ h_1: true }));
    expect(new AcceptedHere(file).list()).toEqual([]);
    fs.writeFileSync(
      file,
      JSON.stringify([null, "h_1", { id: "", at: T, by: "cli" }, { id: "h_2", at: "soon", by: "cli" }, { id: "h_3", at: T, by: "hub" }, { id: "x".repeat(65), at: T, by: "cli" }, { id: "h_ok", at: T, by: "policy" }]),
    );
    expect(new AcceptedHere(file).list()).toEqual([{ id: "h_ok", at: T, by: "policy" }]);
  });

  it("without a file it lives in memory only", () => {
    const a = new AcceptedHere();
    a.add("h_1", "cli", T);
    a.prune(new Set(["h_1"]));
    expect(a.list()).toEqual([{ id: "h_1", at: T, by: "cli" }]);
    expect(new AcceptedHere().list()).toEqual([]);
  });
});
