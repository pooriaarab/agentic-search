import { highlightRanges } from "./text.js";
import type { Highlight, Snippet } from "./types.js";

const WINDOW = 160;
const SCAN = 256;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Nearest grapheme boundary at or after (dir 1) or at or before (dir -1) `index`. */
function snapToGrapheme(text: string, index: number, dir: 1 | -1): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const base = Math.max(0, index - SCAN);
  const limit = Math.min(text.length, index + SCAN);
  let best = dir === 1 ? limit : base;
  for (const seg of segmenter.segment(text.slice(base, limit))) {
    const at = base + seg.index;
    if (dir === 1 && at >= index) return at;
    if (dir === -1 && at <= index) best = at;
  }
  return best;
}

/** Build a snippet from allowed item text. Highlight offsets index into `snippet.text`. */
export function makeSnippet(text: string, terms: string[]): Snippet {
  const marks = highlightRanges(text, terms);
  const first = marks[0];
  let start = 0;
  if (first !== undefined) start = Math.max(0, first[0] - Math.floor(WINDOW / 4));
  let end = Math.min(text.length, start + WINDOW);
  // Snap to word edges so the cut never splits a word.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < (first?.[0] ?? end)) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  // A cut must not split a grapheme (an emoji sequence, a letter and its accent).
  start = snapToGrapheme(text, start, 1);
  end = Math.max(start, snapToGrapheme(text, end, -1));
  const lead = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  // One space per whitespace char keeps highlight offsets stable.
  const body = text.slice(start, end).replace(/\s/g, " ");
  const shift = lead.length - start;
  const highlights: Highlight[] = [];
  for (const [s, e] of marks) {
    if (s >= start && e <= end) highlights.push([s + shift, e + shift]);
  }
  return { text: lead + body + tail, highlights };
}
