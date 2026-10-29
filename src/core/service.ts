import { ownerPolicy } from "./access.js";
import { decodeCursor, encodeCursor, queryDigest, type CursorPosition } from "./cursor.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { makeSnippet } from "./snippet.js";
import { highlightRanges, queryTerms } from "./text.js";
import type {
  AccessPolicy,
  AccessRef,
  IndexedItem,
  IndexStore,
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
  /** Defaults to the owner-only policy. */
  access?: AccessPolicy;
  logger?: Logger;
  /** Most store hits one search call may scan. Bounds the cost of a page full of hidden items. */
  maxScan?: number;
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

export function createSearch(opts: SearchServiceOptions): SearchService {
  const { store } = opts;
  const access = opts.access ?? ownerPolicy;
  const log = opts.logger ?? noopLogger;
  const maxScan = opts.maxScan ?? 1_000;
  const now = opts.now ?? Date.now;

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

  function parseItems(input: unknown): IndexedItem[] {
    const list = Array.isArray(input) ? input : [input];
    if (list.length === 0) throw new ValidationError("no items given");
    if (list.length > LIMITS.batch) throw new ValidationError(`at most ${LIMITS.batch} items per call`);
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

  return {
    async index(principalIn, input) {
      const principal = parsePrincipal(principalIn);
      const items = parseItems(input);
      await guardWrites(principal, items);
      await store.upsert(items);
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
      const digest = queryDigest({ terms, filter });
      let after: CursorPosition | undefined =
        request.cursor === undefined ? undefined : decodeCursor(request.cursor, digest);

      const batch = Math.min(100, Math.max(limit * 2, 20));
      const kept: { item: IndexedItem; score: number }[] = [];
      let scanned = 0;
      while (kept.length <= limit && scanned < maxScan) {
        const rows = await store.search({ terms, filter, after, limit: batch });
        if (rows.length === 0) break;
        const ok = await readable(principal, rows.map((r) => r.item));
        for (let i = 0; i < rows.length && kept.length <= limit; i++) {
          if (ok[i]) kept.push(rows[i] as { item: IndexedItem; score: number });
        }
        scanned += rows.length;
        const tail = rows[rows.length - 1] as { item: IndexedItem; score: number };
        after = { score: tail.score, id: tail.item.id };
        if (rows.length < batch) break;
      }
      const more = kept.length > limit;
      const page = kept.slice(0, limit);
      const hits: SearchHit[] = page.map(({ item }) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        titleHighlights: highlightRanges(item.title, terms),
        snippet: makeSnippet(item.text, terms),
        resource: item.resource,
        owner: item.owner,
        updatedAt: item.updatedAt,
      }));
      const out: SearchPage = { hits };
      const lastKept = page[page.length - 1];
      // The cursor names the last item the caller received, never a scanned hidden one.
      if (more && lastKept !== undefined) {
        out.nextCursor = encodeCursor({ score: lastKept.score, id: lastKept.item.id }, digest);
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
      const items = input.length === 0 ? [] : parseItems(input);
      for (const item of items) if (item.owner !== owner) throw new ValidationError("every item must belong to owner");
      await guardWrites(principal, items);
      const keep = new Set(items.map((i) => i.id));
      let removed = 0;
      let afterId: string | undefined;
      for (;;) {
        const rows = await store.listByOwner(owner, { limit: LIMITS.batch, after: afterId });
        for (const r of rows) {
          if (!keep.has(r.id) && (await store.remove(r.id))) removed++;
        }
        if (rows.length < LIMITS.batch) break;
        afterId = (rows[rows.length - 1] as IndexedItem).id;
      }
      await store.upsert(items);
      log.event("reindex", { indexed: items.length, removed });
      return { indexed: items.length, removed };
    },

    async eraseOwner(principalIn, owner) {
      const principal = parsePrincipal(principalIn);
      if (typeof owner !== "string" || owner.length === 0) throw new ValidationError("owner is required");
      if (!(await manageable(principal, owner))) throw new ForbiddenError();
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
