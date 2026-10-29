import { describe, expect, test } from "vitest";
import { makeSnippet } from "./snippet.js";
import { highlightRanges, queryTerms, tokenize } from "./text.js";

describe("text", () => {
  test("tokenize folds case and accents and keeps offsets of the original", () => {
    expect(tokenize("Zürich, ÉCOLE!")).toEqual([
      { term: "zurich", start: 0, end: 6 },
      { term: "ecole", start: 8, end: 13 },
    ]);
  });

  test("queryTerms dedupes and drops punctuation", () => {
    expect(queryTerms('"Hello" hello, (WORLD)')).toEqual(["hello", "world"]);
    expect(queryTerms("*** ()")).toEqual([]);
  });

  test("last term highlights as a prefix, earlier terms must be whole words", () => {
    const text = "budgets and budget plans";
    expect(highlightRanges(text, ["budget", "pla"])).toEqual([
      [12, 18],
      [19, 24],
    ]);
  });
});

describe("snippet", () => {
  test("short text comes back whole with highlights", () => {
    const s = makeSnippet("the quick brown fox", ["quick"]);
    expect(s).toEqual({ text: "the quick brown fox", highlights: [[4, 9]] });
  });

  test("long text is windowed around the first match and offsets stay valid", () => {
    const text = `${"lorem ipsum ".repeat(60)}needle ${"dolor sit ".repeat(60)}`;
    const s = makeSnippet(text, ["needle"]);
    expect(s.text.length).toBeLessThan(220);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.highlights).toHaveLength(1);
    const [a, b] = s.highlights[0]!;
    expect(s.text.slice(a, b)).toBe("needle");
  });

  test("newlines keep one character each so offsets hold", () => {
    const s = makeSnippet("a\nb needle", ["needle"]);
    expect(s.text).toBe("a b needle");
    expect(s.text.slice(...s.highlights[0]!)).toBe("needle");
  });

  test("no match in text gives the opening and no highlights", () => {
    const s = makeSnippet("plain opening text", ["zzz"]);
    expect(s.highlights).toEqual([]);
    expect(s.text).toBe("plain opening text");
  });
});
