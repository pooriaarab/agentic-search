import { parsePrincipal, type Json } from "agentic-identity";
import type { IndexedItem, IndexStore, PrincipalKind } from "./core/types.js";
import { LIMITS, parseItem } from "./core/validate.js";
import type { VectorEntry, VectorStore } from "./core/vector.js";

/** Matches AccountSubject in the identity account registry. Ids must be unique across kinds. */
export interface SearchAccountSubject { id: string; kind: PrincipalKind }

/** Vector stores used for account operations must enumerate their owner records, including orphans. */
export interface AccountVectorStore extends VectorStore {
  /** Ordered by id ascending, with an exclusive `after`. */
  listByOwner(owner: string, opts: { limit: number; after?: string }): Promise<VectorEntry[]>;
}

export interface SearchAccountDeps {
  store: IndexStore;
  /** The same vector store as search uses. Pass null only for a lexical-only index. */
  vectors: AccountVectorStore | null;
}

/** Structurally matches AccountPackage<SearchAccountDeps>; identity 0.9 has only the older AccountApp. */
export interface SearchAccount {
  id: "search";
  exportAccount(subject: SearchAccountSubject, deps: SearchAccountDeps): Promise<Record<"items" | "vectors", Json[]>>;
  eraseAccount(subject: SearchAccountSubject, deps: SearchAccountDeps): Promise<Record<"items" | "vectors", number>>;
}

function check(subject: SearchAccountSubject, deps: SearchAccountDeps): string {
  const { id } = parsePrincipal(subject);
  if (id.length > LIMITS.id) throw new Error("invalid account subject");
  if (typeof deps?.store?.listByOwner !== "function" || typeof deps.store.removeByOwner !== "function") {
    throw new Error("account operations need an index store");
  }
  if (deps.vectors !== null && (typeof deps.vectors?.listByOwner !== "function" || typeof deps.vectors.removeByOwner !== "function")) {
    throw new Error("account operations need a vector store or explicit null");
  }
  return id;
}

async function collect<T extends { id: string; owner: string }>(
  owner: string,
  read: (opts: { limit: number; after?: string }) => Promise<T[]>,
  validate: (row: T) => T,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const rows = await read({ limit: 100, after });
    if (!Array.isArray(rows) || rows.length > 100) throw new Error("invalid account page");
    for (const raw of rows) {
      const row = validate(raw);
      if (row.owner !== owner || (after !== undefined && row.id <= after)) throw new Error("invalid account ownership or order");
      out.push(row);
      after = row.id;
    }
    if (rows.length < 100) return out;
  }
}

function vector(row: VectorEntry): VectorEntry {
  if (typeof row?.id !== "string" || row.id.length === 0 || row.id.length > LIMITS.id ||
      typeof row.owner !== "string" || !Array.isArray(row.vector) || row.vector.length === 0 ||
      Array.from(row.vector).some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error("invalid account vector");
  }
  return { id: row.id, owner: row.owner, vector: [...row.vector] };
}

async function records(owner: string, { store, vectors }: SearchAccountDeps) {
  const items: IndexedItem[] = await collect(owner, (opts) => store.listByOwner(owner, opts), parseItem);
  const entries = vectors === null ? [] : await collect(owner, (opts) => vectors.listByOwner(owner, opts), vector);
  return { items, vectors: entries };
}

/** Trusted host API: authenticate and authorize the account operation before calling. Stop writes first. */
export const searchAccount: SearchAccount = {
  id: "search",
  async exportAccount(subject, deps) {
    const owner = check(subject, deps);
    const all = await records(owner, deps);
    // parseItem builds a detached, known-field record. Vector validation does the same.
    return all as unknown as Record<"items" | "vectors", Json[]>;
  },
  async eraseAccount(subject, deps) {
    const owner = check(subject, deps);
    // Validate every selected row before any mutation. A damaged page must not become success.
    await records(owner, deps);
    // Vectors first: a retry still discovers the index rows if this step fails.
    const vectors = deps.vectors === null ? 0 : await deps.vectors.removeByOwner(owner);
    const items = await deps.store.removeByOwner(owner);
    if (![items, vectors].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid account erase count");
    return { items, vectors };
  },
};
