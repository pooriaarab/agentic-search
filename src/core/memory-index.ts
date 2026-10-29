import { passes } from "./filter.js";
import { analyzeItem } from "./analyze.js";
import { termScore } from "./score.js";
import { matchesTerm } from "./text.js";
import type { IndexedItem, IndexStore, StoreHit, StoreQuery } from "./types.js";

export type MemoryBacking = Map<string, Doc>;

interface Doc {
  item: IndexedItem;
  tf: Map<string, number>;
  length: number;
}

function analyze(item: IndexedItem): Doc {
  return { item, ...analyzeItem(item) };
}

/**
 * In-memory index with BM25-shaped ranking (see score.ts). Title tokens count three times.
 * It scans every item per query, so use it for tests and small data sets.
 * Pass a shared map to make two instances see the same data.
 */
export class MemoryIndex implements IndexStore {
  private readonly docs = new Map<string, Doc>();

  constructor(backing?: MemoryBacking) {
    if (backing !== undefined) this.docs = backing;
  }

  async upsert(items: IndexedItem[]): Promise<void> {
    for (const item of items) this.docs.set(item.id, analyze({ ...item, resource: { ...item.resource } }));
  }

  async get(id: string): Promise<IndexedItem | null> {
    const doc = this.docs.get(id);
    return doc ? structuredClone(doc.item) : null;
  }

  async remove(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  async removeByOwner(owner: string): Promise<number> {
    let n = 0;
    for (const [id, doc] of [...this.docs]) {
      if (doc.item.owner === owner) {
        this.docs.delete(id);
        n++;
      }
    }
    return n;
  }

  async listByOwner(owner: string, opts: { limit: number; after?: string }): Promise<IndexedItem[]> {
    return [...this.docs.values()]
      .map((d) => d.item)
      .filter((i) => i.owner === owner && (opts.after === undefined || i.id > opts.after))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, opts.limit)
      .map((i) => structuredClone(i));
  }

  async search(q: StoreQuery): Promise<StoreHit[]> {
    const all = [...this.docs.values()];
    const last = q.terms.length - 1;
    if (last < 0) return [];
    const hits: StoreHit[] = [];
    for (const d of all) {
      if (!passes(d.item, q.filter)) continue;
      let score = 0;
      let all_ = true;
      for (let i = 0; i < q.terms.length; i++) {
        let tf = 0;
        for (const [t, c] of d.tf) if (matchesTerm(t, q.terms[i] as string, i === last)) tf += c;
        if (tf === 0) {
          all_ = false;
          break;
        }
        score += termScore(tf, d.length);
      }
      if (all_) hits.push({ item: structuredClone(d.item), score });
    }
    hits.sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1));
    const after = q.after;
    const start =
      after === undefined
        ? 0
        : hits.findIndex((h) => h.score < after.score || (h.score === after.score && h.item.id > after.id));
    if (start === -1) return [];
    return hits.slice(start, start + q.limit);
  }
}
