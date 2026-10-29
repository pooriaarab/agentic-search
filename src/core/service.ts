import { ownerPolicy } from "./access.js";
import { createCursorCodec, queryDigest, type CursorPosition } from "./cursor.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { makeSnippet } from "./snippet.js";
import { passes } from "./filter.js";
import { highlightRanges, queryTerms } from "./text.js";
import {
  embedChecked,
  embedText,
  reciprocalRankFusion,
  type Embedder,
  type HybridRanker,
  type Ranked,
  type VectorStore,
} from "./vector.js";
import type {
  AccessPolicy,
  AccessRef,
  IndexedItem,
  IndexStore,
  ItemFilter,
  Logger,
  OwnerExport,
  Principal,
  SearchHit,
  SearchPage,
  SearchRequest,
} from "./types.js";
import { LIMITS, parseFilter, parseItem, parseLimit, parsePrincipal } from "./validate.js";

export const noopLogger: Logger = { event() {} };

export interface SearchServiceOptions {
  store: IndexStore;
  /** Seals cursors. At least 32 bytes. Keep it the same across Worker instances. */
  cursorSecret: string | Uint8Array;
  /** Defaults to the owner-only policy. */
  access?: AccessPolicy;
  logger?: Logger;
  /** Most store hits one search call may scan. Bounds the cost of a page full of hidden items. */
  maxScan?: number;
  /** Turns on hybrid search. Items get vectors when indexed, and erase removes them too. */
  vectors?: {
    embedder: Embedder;
    store: VectorStore;
    /** Defaults to reciprocal rank fusion. */
    rank?: HybridRanker;
    /** Candidates taken from each side before fusion. Defaults to 100. */
    depth?: number;
    /** Vector hits at or below this cosine score are dropped. Defaults to 0. */
    minScore?: number;
  };
  now?: () => number;
}

export interface SearchService {
  index(principal: Principal, items: unknown): Promise<{ indexed: number }>;
  remove(principal: Principal, id: string): Promise<{ removed: boolean }>;
  search(principal: Principal, request: SearchRequest): Promise<SearchPage>;
  /** Replace everything one owner has indexed with the given items. */
  reindex(principal: Principal, owner: string, items: unknown): Promise<{ indexed: number; removed: number }>;
  eraseOwner(principal: Principal, owner: string): Promise<{ removed: number }>;
  exportOwner(principal: Principal, owner: string): Promise<OwnerExport>;
}

const refOf = (i: IndexedItem): AccessRef => ({
  id: i.id,
  kind: i.kind,
  owner: i.owner,
  resource: { ...i.resource },
});

export async function createSearch(opts: SearchServiceOptions): Promise<SearchService> {
  const cursors = await createCursorCodec(opts.cursorSecret);
  const { store } = opts;
  const access = opts.access ?? ownerPolicy;
  const log = opts.logger ?? noopLogger;
  const maxScan = opts.maxScan ?? 1_000;
  if (!Number.isInteger(maxScan) || maxScan < 1) throw new ValidationError("maxScan must be a positive integer");
  const now = opts.now ?? Date.now;
  const vec = opts.vectors;
  const rank = vec?.rank ?? reciprocalRankFusion();
  const depth = vec?.depth ?? 100;
  if (!Number.isInteger(depth) || depth < 1 || depth > 1_000) throw new ValidationError("depth must be from 1 to 1000");

  const minScore = vec?.minScore ?? 0;
  if (typeof minScore !== "number" || !Number.isFinite(minScore)) throw new ValidationError("minScore must be a number");

  /** Embed in batches: real embedders cap the batch size. */
  const embedItems = async (items: IndexedItem[]): Promise<number[][]> => {
    const out: number[][] = [];
    if (vec === undefined) return out;
    for (let i = 0; i < items.length; i += LIMITS.batch) {
      out.push(...(await embedChecked(vec.embedder, items.slice(i, i + LIMITS.batch).map(embedText))));
    }
    return out;
  };
  const putVectors = async (items: IndexedItem[], vectors: number[][]) => {
    if (vec !== undefined) {
      await vec.store.upsert(items.map((it, i) => ({ id: it.id, owner: it.owner, vector: vectors[i] as number[] })));
    }
  };

  const toHit = (item: IndexedItem, terms: string[]): SearchHit => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    titleHighlights: highlightRanges(item.title, terms),
    snippet: makeSnippet(item.text, terms),
    resource: item.resource,
    owner: item.owner,
    updatedAt: item.updatedAt,
  });

  /** Fail closed: only a strict `true` per ref allows. A malformed answer throws. */
  async function readable(principal: Principal, items: IndexedItem[]): Promise<boolean[]> {
    if (items.length === 0) return [];
    const verdict = await access.canRead(principal, items.map(refOf));
    if (!Array.isArray(verdict) || verdict.length !== items.length) {
      throw new Error("access policy returned a malformed answer");
    }
    return verdict.map((v) => v === true);
  }

  async function writable(principal: Principal, item: IndexedItem): Promise<boolean> {
    return (await access.canWrite(principal, refOf(item))) === true;
  }

  async function manageable(principal: Principal, owner: string): Promise<boolean> {
    return (await access.canManageOwner(principal, owner)) === true;
  }

  function parseItems(input: unknown, max: number = LIMITS.batch): IndexedItem[] {
    const list = Array.isArray(input) ? input : [input];
    if (list.length === 0) throw new ValidationError("no items given");
    if (list.length > max) throw new ValidationError(`at most ${max} items per call`);
    return list.map(parseItem);
  }

  async function guardWrites(principal: Principal, items: IndexedItem[]): Promise<void> {
    for (const item of items) {
      if (!(await writable(principal, item))) throw new ForbiddenError();
      // Overwriting an item that belongs to someone else needs rights over that item too.
      const existing = await store.get(item.id);
      if (existing !== null && !(await writable(principal, existing))) throw new ForbiddenError();
    }
  }

  /** Word hits plus vector hits, both cut to what the caller may read BEFORE they meet in the ranker. */
  async function hybrid(
    principal: Principal,
    request: SearchRequest,
    terms: string[],
    filter: ItemFilter,
    limit: number,
    digest: string,
  ): Promise<SearchPage> {
    const offset = request.cursor === undefined ? 0 : (await cursors.decode(request.cursor, digest)).score;
    if (!Number.isInteger(offset) || offset < 0 || offset > 2 * depth) throw new ValidationError("invalid cursor");
    const items = new Map<string, IndexedItem>();
    const lexical: Ranked[] = [];
    let after: CursorPosition | undefined;
    for (let scanned = 0; lexical.length < depth && scanned < maxScan; ) {
      const rows = await store.search({ terms, filter, after, limit: 100 });
      const ok = await readable(principal, rows.map((r) => r.item));
      rows.forEach((r, i) => {
        if (ok[i] && lexical.length < depth) {
          lexical.push({ id: r.item.id, score: r.score });
          items.set(r.item.id, r.item);
        }
      });
      scanned += rows.length;
      const tail = rows[rows.length - 1];
      if (tail === undefined || rows.length < 100) break;
      after = { score: tail.score, id: tail.item.id };
    }
    const { embedder, store: vstore } = vec as NonNullable<typeof vec>;
    const [query] = await embedChecked(embedder, [request.query]);
    // Ask for more vectors until `depth` of them are readable, so other people's
    // items cannot push every readable one out. Each id is loaded and checked once.
    const verdict = new Map<string, IndexedItem | null>();
    const vector: Ranked[] = [];
    for (let want = depth; ; want = Math.min(want * 4, maxScan)) {
      const near = await vstore.query(query as number[], want);
      const fresh = near.filter((h) => {
        if (typeof h?.id !== "string" || typeof h.score !== "number" || !Number.isFinite(h.score)) {
          throw new Error("the vector store returned a bad hit");
        }
        return !verdict.has(h.id);
      });
      const loaded = await Promise.all(fresh.map((h) => items.get(h.id) ?? store.get(h.id)));
      // An id the store no longer holds, or one outside the filter, is dropped.
      const cands = fresh.flatMap((h, i) => {
        const item = loaded[i];
        return item !== null && item !== undefined && passes(item, filter) ? [item] : [];
      });
      const ok = await readable(principal, cands);
      fresh.forEach((h) => verdict.set(h.id, null));
      cands.forEach((item, i) => verdict.set(item.id, ok[i] ? item : null));
      vector.length = 0;
      for (const h of near) {
        const item = verdict.get(h.id);
        if (item && h.score > minScore && vector.length < depth) {
          vector.push({ id: h.id, score: h.score });
          items.set(h.id, item);
        }
      }
      if (vector.length >= depth || near.length < want || want >= maxScan) break;
    }
    const fused = rank({ lexical, vector });
    const seen = new Set<string>();
    const ordered: IndexedItem[] = [];
    for (const r of fused) {
      const item = items.get(r.id);
      if (item === undefined) throw new Error("the ranker returned an id it was not given");
      if (!seen.has(r.id)) ordered.push(item);
      seen.add(r.id);
    }
    const end = offset + limit;
    const out: SearchPage = { hits: ordered.slice(offset, end).map((i) => toHit(i, terms)) };
    if (ordered.length > end) out.nextCursor = await cursors.encode({ score: end, id: "hybrid" }, digest);
    log.event("search", { hits: out.hits.length, lexical: lexical.length, vector: vector.length });
    return out;
  }

  return {
    async index(principalIn, input) {
      const principal = parsePrincipal(principalIn);
      const items = parseItems(input);
      await guardWrites(principal, items);
      // Embed first: a failing embedder stops the call before anything is written.
      const vectors = await embedItems(items);
      // If the vector write fails after this, the call fails and the item may lack its vector until you index it again.
      await store.upsert(items);
      await putVectors(items, vectors);
      log.event("index", { items: items.length });
      return { indexed: items.length };
    },

    async remove(principalIn, id) {
      const principal = parsePrincipal(principalIn);
      if (typeof id !== "string" || id.length === 0 || id.length > LIMITS.id) {
        throw new ValidationError("id must be a non-empty string");
      }
      const existing = await store.get(id);
      // Missing and not-writable look the same, so remove is no existence oracle.
      if (existing === null || !(await writable(principal, existing))) {
        log.event("remove", { removed: 0 });
        return { removed: false };
      }
      // Vector first: if it fails, a retry still finds the item and erases both.
      await vec?.store.remove(id);
      const removed = await store.remove(id);
      log.event("remove", { removed: removed ? 1 : 0 });
      return { removed };
    },

    async search(principalIn, request) {
      const principal = parsePrincipal(principalIn);
      if (typeof request?.query !== "string") throw new ValidationError("query must be a string");
      if (request.query.length > LIMITS.query) throw new ValidationError(`query is longer than ${LIMITS.query}`);
      const terms = queryTerms(request.query);
      if (terms.length === 0) throw new ValidationError("query has no searchable words");
      if (terms.length > LIMITS.terms) throw new ValidationError(`query has more than ${LIMITS.terms} words`);
      const filter = parseFilter(request as unknown as Record<string, unknown>);
      const limit = parseLimit(request.limit);
      const mode = request.mode ?? (vec === undefined ? "lexical" : "hybrid");
      if (mode !== "lexical" && mode !== "hybrid") throw new ValidationError("mode must be lexical or hybrid");
      if (mode === "hybrid" && vec === undefined) throw new ValidationError("hybrid search needs vectors");
      const digest = await queryDigest({ terms, filter, mode, caller: principal.id, actingFor: principal.actingFor ?? null });
      if (mode === "hybrid") return hybrid(principal, request, terms, filter, limit, digest);
      let after: CursorPosition | undefined =
        request.cursor === undefined ? undefined : await cursors.decode(request.cursor, digest);

      const batch = Math.min(100, Math.max(limit * 2, 20));
      const kept: { item: IndexedItem; score: number }[] = [];
      let scanned = 0;
      let exhausted = false;
      while (kept.length <= limit && scanned < maxScan) {
        const rows = await store.search({ terms, filter, after, limit: batch });
        if (rows.length === 0) {
          exhausted = true;
          break;
        }
        const ok = await readable(principal, rows.map((r) => r.item));
        for (let i = 0; i < rows.length && kept.length <= limit; i++) {
          if (ok[i]) kept.push(rows[i] as { item: IndexedItem; score: number });
        }
        scanned += rows.length;
        const tail = rows[rows.length - 1] as { item: IndexedItem; score: number };
        after = { score: tail.score, id: tail.item.id };
        if (rows.length < batch) {
          exhausted = true;
          break;
        }
      }
      const more = kept.length > limit;
      const page = kept.slice(0, limit);
      const hits: SearchHit[] = page.map(({ item }) => toHit(item, terms));
      const out: SearchPage = { hits };
      const lastKept = page[page.length - 1];
      if (more && lastKept !== undefined) {
        out.nextCursor = await cursors.encode({ score: lastKept.score, id: lastKept.item.id }, digest);
      } else if (!more && !exhausted && after !== undefined) {
        // The scan budget ran out before the end. Send a continuation so no match is lost.
        // The page may be short or empty. The sealed cursor keeps the position private.
        out.nextCursor = await cursors.encode(after, digest);
      }
      log.event("search", { hits: hits.length, scanned });
      return out;
    },

    async reindex(principalIn, owner, input) {
      const principal = parsePrincipal(principalIn);
      if (typeof owner !== "string" || owner.length === 0) throw new ValidationError("owner is required");
      if (!(await manageable(principal, owner))) throw new ForbiddenError();
      if (!Array.isArray(input)) throw new ValidationError("items must be a list");
      // An empty list is valid: it clears everything the owner has indexed.
      const items = input.length === 0 ? [] : parseItems(input, LIMITS.reindex);
      for (const item of items) if (item.owner !== owner) throw new ValidationError("every item must belong to owner");
      await guardWrites(principal, items);
      const vectors = await embedItems(items);
      // Write first, then drop stale items, so a failed write never empties the owner.
      for (let i = 0; i < items.length; i += LIMITS.batch) {
        const chunk = items.slice(i, i + LIMITS.batch);
        await store.upsert(chunk);
        await putVectors(chunk, vectors.slice(i, i + LIMITS.batch));
      }
      const keep = new Set(items.map((i) => i.id));
      let removed = 0;
      let afterId: string | undefined;
      for (;;) {
        const rows = await store.listByOwner(owner, { limit: LIMITS.batch, after: afterId });
        for (const r of rows) {
          if (keep.has(r.id)) continue;
          await vec?.store.remove(r.id);
          if (await store.remove(r.id)) removed++;
        }
        if (rows.length < LIMITS.batch) break;
        afterId = (rows[rows.length - 1] as IndexedItem).id;
      }
      log.event("reindex", { indexed: items.length, removed });
      return { indexed: items.length, removed };
    },

    async eraseOwner(principalIn, owner) {
      const principal = parsePrincipal(principalIn);
      if (typeof owner !== "string" || owner.length === 0) throw new ValidationError("owner is required");
      if (!(await manageable(principal, owner))) throw new ForbiddenError();
      await vec?.store.removeByOwner(owner);
      const removed = await store.removeByOwner(owner);
      log.event("erase_owner", { removed });
      return { removed };
    },

    async exportOwner(principalIn, owner) {
      const principal = parsePrincipal(principalIn);
      if (typeof owner !== "string" || owner.length === 0) throw new ValidationError("owner is required");
      if (!(await manageable(principal, owner))) throw new ForbiddenError();
      const items: IndexedItem[] = [];
      let afterId: string | undefined;
      for (;;) {
        const rows = await store.listByOwner(owner, { limit: LIMITS.batch, after: afterId });
        items.push(...rows);
        if (rows.length < LIMITS.batch) break;
        afterId = (rows[rows.length - 1] as IndexedItem).id;
      }
      log.event("export_owner", { items: items.length });
      return { owner, exportedAt: now(), items };
    },
  };
}
