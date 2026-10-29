export const ITEM_KINDS = ["document", "sheet", "slide", "file", "comment"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The thing an indexed item belongs to, for example the document a comment sits on. */
export interface ResourceRef {
  type: string;
  id: string;
}

export interface IndexedItem {
  id: string;
  kind: ItemKind;
  title: string;
  text: string;
  /** Subject id of the person who owns the item. Used for erase and export. */
  owner: string;
  resource: ResourceRef;
  /** Epoch milliseconds. */
  updatedAt: number;
}

export const PRINCIPAL_KINDS = [
  "human",
  "agent_of_human",
  "agent_of_agent",
  "agent",
  "user_token",
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export interface Principal {
  id: string;
  kind: PrincipalKind;
  /** The subject this principal acts for. Required for agent_of_human and user_token. */
  actingFor?: string;
}

export interface ItemFilter {
  kinds?: ItemKind[];
  owner?: string;
  resource?: { type: string; id?: string };
  updatedAfter?: number;
  updatedBefore?: number;
}

export interface SearchRequest extends ItemFilter {
  query: string;
  limit?: number;
  cursor?: string;
}

export type Highlight = [start: number, end: number];

export interface Snippet {
  text: string;
  highlights: Highlight[];
}

export interface SearchHit {
  id: string;
  kind: ItemKind;
  title: string;
  titleHighlights: Highlight[];
  snippet: Snippet;
  resource: ResourceRef;
  owner: string;
  updatedAt: number;
}

/** A page of hits. There is no total count on purpose: a count would leak hidden items. */
export interface SearchPage {
  hits: SearchHit[];
  nextCursor?: string;
}

export interface OwnerExport {
  owner: string;
  exportedAt: number;
  items: IndexedItem[];
}

// ---- ports ----

export interface StoreQuery {
  /** Normalized terms. Every term must match. The last term also matches as a prefix. */
  terms: string[];
  filter: ItemFilter;
  /** Resume after this position. Hits order by score descending, then id ascending. */
  after?: { score: number; id: string };
  limit: number;
}

export interface StoreHit {
  item: IndexedItem;
  /** Higher is better. Only meaningful inside one store. */
  score: number;
}

/**
 * Index store port. Keep it Firestore-friendly: equality filters, keyset
 * pagination, no joins. Adapters pass the contract suite in `agentic-search/testing`.
 */
export interface IndexStore {
  upsert(items: IndexedItem[]): Promise<void>;
  get(id: string): Promise<IndexedItem | null>;
  remove(id: string): Promise<boolean>;
  removeByOwner(owner: string): Promise<number>;
  /** Ordered by id ascending. */
  listByOwner(
    owner: string,
    opts: { limit: number; after?: string },
  ): Promise<IndexedItem[]>;
  search(query: StoreQuery): Promise<StoreHit[]>;
}

export interface AccessRef {
  id: string;
  kind: ItemKind;
  owner: string;
  resource: ResourceRef;
}

/**
 * Access policy port. The service calls `canRead` before any hit, snippet or
 * cursor leaves the package. Only `true` allows. Anything else denies.
 */
export interface AccessPolicy {
  canRead(principal: Principal, refs: AccessRef[]): Promise<boolean[]>;
  canWrite(principal: Principal, ref: AccessRef): Promise<boolean>;
  /** Erase and export rights over everything one owner has indexed. */
  canManageOwner(principal: Principal, owner: string): Promise<boolean>;
}

/** Log port. Fields hold counts and flags only. Never titles, text or owner ids. */
export interface Logger {
  event(name: string, fields?: Record<string, number | boolean>): void;
}
