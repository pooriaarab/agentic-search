import { matchesTerm, tokenize } from "./text.js";
import type { IndexedItem, IndexStore, ItemFilter, StoreHit, StoreQuery } from "./types.js";

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;

export type MemoryBacking = Map<string, Doc>;

interface Doc {
  item: IndexedItem;
  tf: Map<string, number>;
  length: number;
}

function analyze(item: IndexedItem): Doc {
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
  return { item, tf, length };
}

function passes(item: IndexedItem, f: ItemFilter): boolean {
  if (f.kinds !== undefined && !f.kinds.includes(item.kind)) return false;
  if (f.owner !== undefined && item.owner !== f.owner) return false;
  if (f.resource !== undefined) {
    if (item.resource.type !== f.resource.type) return false;
    if (f.resource.id !== undefined && item.resource.id !== f.resource.id) return false;
  }
  if (f.updatedAfter !== undefined && !(item.updatedAt > f.updatedAfter)) return false;
  if (f.updatedBefore !== undefined && !(item.updatedAt < f.updatedBefore)) return false;
  return true;
}

/**
 * In-memory index with BM25 ranking. Title tokens count three times.
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
    const avg = all.reduce((n, d) => n + d.length, 0) / Math.max(all.length, 1) || 1;
    // Document frequency per query term over the whole index.
    const df = q.terms.map((term, i) => {
      let n = 0;
      for (const d of all) for (const t of d.tf.keys()) if (matchesTerm(t, term, i === last)) { n++; break; }
      return n;
    });
    const N = all.length;
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
        const idf = Math.log(1 + (N - (df[i] as number) + 0.5) / ((df[i] as number) + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / avg));
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
