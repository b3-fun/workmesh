import { describe, expect, it } from "vitest";
import { isInjectedPrompt, stripInjected } from "../src/injected";
import * as fromIndex from "../src";
import { INJECTED_FIXTURES } from "./fixtures/injected";

describe("system-injected content (SPEC §19)", () => {
  for (const f of INJECTED_FIXTURES) {
    it(f.name, () => {
      const got = stripInjected(f.text);
      expect(got.kind).toBe(f.kind);
      expect(got.text).toBe(f.clean);
      expect(isInjectedPrompt(f.text)).toBe(f.injectedPrompt);
    });
  }

  it("empty and missing text", () => {
    expect(stripInjected(undefined)).toEqual({ text: "", kind: "none" });
    expect(stripInjected(null)).toEqual({ text: "", kind: "none" });
    expect(stripInjected("")).toEqual({ text: "", kind: "none" });
    expect(isInjectedPrompt(undefined)).toBe(false);
  });

  it("bounded on hostile input", () => {
    const deep = "<a-b>".repeat(5000) + "x";
    const t0 = Date.now();
    stripInjected(deep);
    stripInjected("<x-y/>\n".repeat(10_000) + "end");
    stripInjected(`<agent-message>`.repeat(50) + "body");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("is exported from the package index too", () => {
    expect(fromIndex.stripInjected).toBe(stripInjected);
  });
});
