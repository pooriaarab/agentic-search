import type { ReactNode } from "react";
import type { Highlight } from "../core/types.js";

/**
 * Wrap each highlight range in <mark>. A range from outside the text, an empty range and an
 * overlapping range are skipped, so a bad server reply cannot break the page or leak markup.
 * The text goes to React as a string, so React escapes it.
 */
export function highlighted(text: string, ranges: Highlight[]): ReactNode {
  const sorted = ranges
    .filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] <= text.length && r[0] < r[1])
    .sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of sorted) {
    if (start < at) continue;
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark key={start} className="agd-search__mark">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
