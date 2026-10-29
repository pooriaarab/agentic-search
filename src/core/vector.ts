import type { IndexedItem } from "./types.js";

/**
 * Embedding port. An adapter calls a model you host (for example in the EU).
 * No vendor SDK lives in this package. Every vector has `dimensions` numbers.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorEntry {
  id: string;
  owner: string;
  vector: number[];
}

export interface VectorHit {
  id: string;
  /** Higher is closer. Only meaningful inside one store. */
  score: number;
}

/**
 * Vector store port. It knows ids and owners, never access rules: the service
 * filters every hit through the access policy before it uses it.
 * Erase by id and by owner must remove the vectors too.
 */
export interface VectorStore {
  upsert(entries: VectorEntry[]): Promise<void>;
  remove(id: string): Promise<boolean>;
  removeByOwner(owner: string): Promise<number>;
  /** Nearest first. */
  query(vector: number[], limit: number): Promise<VectorHit[]>;
}

export interface Ranked {
  id: string;
  score: number;
}

/**
 * Hybrid ranking hook. It gets the word hits and the vector hits the caller
 * may read, each best first, and returns one list best first. It never sees
 * an item the caller cannot read, so a custom ranker cannot leak one.
 */
export type HybridRanker = (input: { lexical: Ranked[]; vector: Ranked[] }) => Ranked[];

/** Default ranker: reciprocal rank fusion. A hit's score is the sum of 1 / (k + rank) over both lists. */
export function reciprocalRankFusion(k = 60): HybridRanker {
  return ({ lexical, vector }) => {
    const score = new Map<string, number>();
    for (const list of [lexical, vector]) {
      list.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + i + 1)));
    }
    return [...score]
      .map(([id, s]) => ({ id, score: s }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  };
}

/** The text an embedder sees for one item. */
export const embedText = (item: Pick<IndexedItem, "title" | "text">): string => `${item.title}\n${item.text}`;

function check(vector: unknown, dimensions: number): asserts vector is number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`a vector must hold ${dimensions} finite numbers`);
  }
}

/** Embed texts and check the answer. A wrong count or a bad vector throws. */
export async function embedChecked(embedder: Embedder, texts: string[]): Promise<number[][]> {
  const out = await embedder.embed(texts);
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error("the embedder returned the wrong number of vectors");
  for (const v of out) check(v, embedder.dimensions);
  return out;
}

/** In-memory reference vector store. Brute-force cosine similarity. For tests and small sets. */
export class MemoryVectorStore implements VectorStore {
  private readonly rows = new Map<string, { owner: string; vector: number[]; norm: number }>();

  constructor(readonly dimensions: number) {}

  async upsert(entries: VectorEntry[]): Promise<void> {
    for (const e of entries) {
      check(e.vector, this.dimensions);
      const norm = Math.hypot(...e.vector);
      this.rows.set(e.id, { owner: e.owner, vector: [...e.vector], norm });
    }
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async removeByOwner(owner: string): Promise<number> {
    let n = 0;
    for (const [id, r] of [...this.rows]) {
      if (r.owner === owner) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }

  async query(vector: number[], limit: number): Promise<VectorHit[]> {
    check(vector, this.dimensions);
    const qn = Math.hypot(...vector);
    const hits: VectorHit[] = [];
    for (const [id, r] of this.rows) {
      const dot = r.vector.reduce((s, x, i) => s + x * (vector[i] as number), 0);
      hits.push({ id, score: qn === 0 || r.norm === 0 ? 0 : dot / (qn * r.norm) });
    }
    return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, limit);
  }

  /** Test helper: how many vectors are stored. */
  get size(): number {
    return this.rows.size;
  }
}
