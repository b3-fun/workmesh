import { describe, expect, it } from "vitest";
import { oneLine } from "../src/lib/one-line";

/** Characters are built from code points here, so this file holds no invisible character itself. */
const cp = (...points: number[]): string => String.fromCodePoint(...points);

describe("oneLine: text from a hub, fit to show on one line", () => {
  it("turns line breaks, tabs and other control characters into single spaces", () => {
    expect(oneLine("a\tb\nc\r\nd")).toBe("a b c d");
    expect(oneLine(`a${cp(0x2028)}b${cp(0x2029)}c`)).toBe("a b c");
    expect(oneLine(`  red${cp(0x1b)}[31m text${cp(0x07)}${cp(0x7f)}${cp(0x9b)}  `)).toBe("red [31m text");
  });

  it("drops invisible formatting characters: zero-width, direction marks and overrides, soft hyphens", () => {
    const hidden = cp(0x200b, 0x200d, 0x200e, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff, 0xad, 0x2060);
    expect(oneLine(`sams${hidden}-laptop`)).toBe("sams-laptop");
    // A lone half of a surrogate pair is not a character.
    expect(oneLine(`a${String.fromCharCode(0xd800)}b`)).toBe("ab");
  });

  it("collapses runs of whitespace, no-break spaces included, and trims the ends", () => {
    expect(oneLine(`  Lisbon,${cp(0xa0)}${cp(0xa0)}  Portugal `)).toBe("Lisbon, Portugal");
    expect(oneLine(" \n ")).toBe("");
  });

  it("keeps letters of any script", () => {
    expect(oneLine("São Paulo, 東京")).toBe("São Paulo, 東京");
  });

  it("cuts to the limit in whole characters and marks the cut", () => {
    expect(oneLine("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
    expect(oneLine("x".repeat(10), 10)).toBe("x".repeat(10));
    const face = cp(0x1f600);
    expect(oneLine(face.repeat(5), 3)).toBe(`${face}${face}…`);
    expect(oneLine("x".repeat(300))).toHaveLength(200);
  });
});
