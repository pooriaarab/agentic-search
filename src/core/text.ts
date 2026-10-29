import type { Highlight } from "./types.js";

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** Lowercase, fold compatibility forms, strip diacritics. */
export function normalizeToken(token: string): string {
  return token.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

export interface Token {
  term: string;
  start: number;
  end: number;
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const term = normalizeToken(m[0]);
    if (term.length > 0) out.push({ term, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query).map((t) => t.term))];
}

/** True when a document token satisfies a query term. The last query term is a prefix. */
export function matchesTerm(token: string, term: string, prefix: boolean): boolean {
  return prefix ? token.startsWith(term) : token === term;
}

export function highlightRanges(text: string, terms: string[]): Highlight[] {
  if (terms.length === 0) return [];
  const last = terms.length - 1;
  const out: Highlight[] = [];
  for (const tok of tokenize(text)) {
    if (terms.some((t, i) => matchesTerm(tok.term, t, i === last))) out.push([tok.start, tok.end]);
  }
  return out;
}
