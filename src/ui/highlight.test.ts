import { isValidElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { highlighted } from "./highlight.js";

// Show a result as plain text, with ranges in [ ].
function flat(node: ReactNode): string {
  return (node as ReactNode[])
    .map((part) => (isValidElement(part) ? `[${(part.props as { children: string }).children}]` : String(part)))
    .join("");
}

describe("highlighted", () => {
  test.each([
    ["a good range", "hello world", [[6, 11]], "hello [world]"],
    ["ranges out of order", "abcdef", [[4, 6], [0, 2]], "[ab]cd[ef]"],
    ["an overlapping range", "abcdef", [[0, 4], [2, 5]], "[abcd]ef"],
    ["a range past the end", "abc", [[1, 9]], "abc"],
    ["a negative start", "abc", [[-1, 2]], "abc"],
    ["an empty range", "abc", [[1, 1]], "abc"],
    ["a fraction", "abc", [[0.5, 2]], "abc"],
    ["no ranges", "abc", [], "abc"],
  ] as const)("%s", (_name, text, ranges, expected) => {
    expect(flat(highlighted(text, ranges as never))).toBe(expected);
  });

  test("markup in the text stays text", () => {
    expect(flat(highlighted("<b>x</b>", [[0, 3]]))).toBe("[<b>]x</b>");
  });
});
