/**
 * Ranking uses saturated term frequency with length normalisation (the BM25
 * shape) and NO corpus statistics: no document frequency, no average length.
 * The pivot below is a constant. A score then depends only on the item and the
 * query, so items a caller cannot see never change the order that caller gets.
 */
export const K1 = 1.2;
export const B = 0.75;
export const LENGTH_PIVOT = 120;

export function termScore(tf: number, length: number): number {
  return (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / LENGTH_PIVOT));
}
