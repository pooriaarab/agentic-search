import { tokenize } from "./text.js";
import type { IndexedItem } from "./types.js";

export const TITLE_WEIGHT = 3;

export interface Analysis {
  /** Weighted term frequency. Title tokens count `TITLE_WEIGHT` times. */
  tf: Map<string, number>;
  /** Sum of all weighted frequencies. */
  length: number;
}

export function analyzeItem(item: Pick<IndexedItem, "title" | "text">): Analysis {
  const tf = new Map<string, number>();
  let length = 0;
  for (const [text, weight] of [
    [item.title, TITLE_WEIGHT],
    [item.text, 1],
  ] as const) {
    for (const tok of tokenize(text)) {
      tf.set(tok.term, (tf.get(tok.term) ?? 0) + weight);
      length += weight;
    }
  }
  return { tf, length };
}
