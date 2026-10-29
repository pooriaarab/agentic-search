// A typed client for the Worker HTTP API. It uses only fetch, URL, and AbortSignal, so it runs in
// browsers, Workers, and Node 22. It never retries and never follows a redirect.
// The Worker sends `{ "error": "<text>" }`, so the client derives the code from the HTTP status.
import type { IndexedItem, OwnerExport, SearchPage, SearchRequest } from "./core/types.js";

export type { IndexedItem, ItemKind, OwnerExport, SearchHit, SearchPage, SearchRequest } from "./core/types.js";

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INTERNAL"
  // Any other status, or a reply that is not an API reply, for example from a proxy.
  | "UNKNOWN";

const BY_STATUS: Record<number, ApiErrorCode> = {
  400: "INVALID_INPUT",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL",
};

/** Thrown for every reply that is not a success. `code` comes from the HTTP `status`. */
export class SearchApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = "SearchApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ClientOptions {
  /** The Worker origin, for example https://search.example.com. The client adds /api/v1. */
  baseUrl: string;
  /** A bearer credential that the Worker's verifier accepts. */
  token: string;
  fetch?: typeof fetch;
}

/**
 * Every method takes an optional signal. An aborted call rejects with the signal reason, not a
 * SearchApiError. A write that was aborted after it was sent may still have applied.
 */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface Health {
  ok: true;
  name: string;
  version: string;
}

export interface SearchClient {
  /** The Worker does not check the token on this route. The client still sends it. */
  health(options?: CallOptions): Promise<Health>;
  search(request: SearchRequest, options?: CallOptions): Promise<SearchPage>;
  /** Index one item or a list. Indexing the same id again replaces the item. */
  index(items: IndexedItem | IndexedItem[], options?: CallOptions): Promise<{ indexed: number }>;
  remove(id: string, options?: CallOptions): Promise<{ removed: boolean }>;
  exportOwner(owner: string, options?: CallOptions): Promise<OwnerExport>;
  eraseOwner(owner: string, options?: CallOptions): Promise<{ removed: number }>;
}

// A success reply must have the expected shape, or the call fails. A proxy or a wrong baseUrl can
// answer 200 with any body.
type Shape = "health" | "page" | "indexed" | "removed" | "export" | "erased";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SHAPES: Record<Shape, (v: unknown) => boolean> = {
  health: (v) => isObject(v) && v.ok === true && typeof v.name === "string" && typeof v.version === "string",
  page: (v) => isObject(v) && Array.isArray(v.hits) && v.hits.every((h) => isObject(h) && typeof h.id === "string") && (v.nextCursor === undefined || typeof v.nextCursor === "string"),
  indexed: (v) => isObject(v) && typeof v.indexed === "number",
  removed: (v) => isObject(v) && typeof v.removed === "boolean",
  export: (v) => isObject(v) && typeof v.owner === "string" && typeof v.exportedAt === "number" && Array.isArray(v.items),
  erased: (v) => isObject(v) && typeof v.removed === "number",
};

export function createClient(options: ClientOptions): SearchClient {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") throw new TypeError("createClient needs a baseUrl");
  if (typeof options.token !== "string" || options.token === "") throw new TypeError("createClient needs a token");
  // A bad character makes fetch throw an error that holds the whole header value. Refuse it here with a fixed message.
  if (!/^[\x21-\x7E]+$/.test(options.token)) throw new TypeError("token must be visible ASCII with no spaces or line breaks");
  let origin: URL;
  try {
    origin = new URL(options.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new TypeError("baseUrl must be an http or https URL");
  if (origin.search !== "" || origin.hash !== "" || origin.username !== "" || origin.password !== "") {
    throw new TypeError("baseUrl must have no query, hash, or credentials");
  }
  const root = `${origin.origin}${origin.pathname.replace(/\/+$/, "")}/api/v1`;
  const token = options.token;
  // Read at call time so a test can swap the global. A custom fetch is called as a plain function,
  // with no `this`, so `window.fetch` and a Workers `fetch` work.
  const custom = options.fetch;
  const send = (input: string, init: RequestInit) => (custom === undefined ? globalThis.fetch(input, init) : custom(input, init));
  // A segment of "", ".", or ".." is dropped or resolved by the URL parser, so the call would go to
  // another route. Refuse it. encodeURIComponent turns "%" into "%25", so no other id can do this.
  const seg = (value: string): string => {
    if (typeof value !== "string" || /^\.{0,2}$/.test(value)) throw new TypeError("an id must be a non-empty string that is not . or ..");
    return encodeURIComponent(value);
  };

  async function call<T>(method: string, path: string, body: unknown, callOptions: CallOptions | undefined, shape: Shape): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await send(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: callOptions?.signal,
      // Never follow a redirect: it would send the token to another host.
      redirect: "manual",
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message = isObject(parsed) && typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
      throw new SearchApiError(BY_STATUS[response.status] ?? "UNKNOWN", response.status, message);
    }
    if (!SHAPES[shape](parsed)) throw new SearchApiError("UNKNOWN", response.status, `the reply is not a ${shape}`);
    return parsed as T;
  }

  const methods: SearchClient = {
    health: (o) => call("GET", "/health", undefined, o, "health"),
    search: (request, o) => call("POST", "/search", request, o, "page"),
    index: (items, o) => call("POST", "/items", { items: Array.isArray(items) ? items : [items] }, o, "indexed"),
    remove: (id, o) => call("DELETE", `/items/${seg(id)}`, undefined, o, "removed"),
    exportOwner: (owner, o) => call("GET", `/owners/${seg(owner)}/export`, undefined, o, "export"),
    eraseOwner: (owner, o) => call("DELETE", `/owners/${seg(owner)}`, undefined, o, "erased"),
  };

  // A refused id throws inside a method, before any request. Every method returns a promise, so the
  // caller sees a rejection, not a throw.
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [name, async (...args: unknown[]) => (method as (...a: unknown[]) => Promise<unknown>)(...args)]),
  ) as unknown as SearchClient;
}
