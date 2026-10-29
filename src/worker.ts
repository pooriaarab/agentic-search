import { createSearch, type SearchService } from "./core/service.js";
import { ForbiddenError, ValidationError } from "./core/errors.js";
import { D1Index, type D1Like } from "./adapters/d1.js";
import type { Logger, Principal } from "./core/types.js";
import { VERSION } from "./version.js";

/**
 * Auth port. Return the verified principal, or null for an unauthenticated
 * request. A throw counts as unauthenticated. The core never reads tokens.
 */
export interface AuthVerifier {
  verify(request: Request, env: WorkerEnv): Promise<Principal | null>;
}

export interface WorkerEnv {
  SEARCH_NAME?: string;
  DB?: D1Like;
  /** Seals cursors. At least 32 bytes. */
  SEARCH_CURSOR_SECRET?: string;
  /** Set to "1" to trust principal headers. For local trials only: it has no authentication. */
  SEARCH_UNSAFE_NO_AUTH?: string;
}

export interface WorkerOptions {
  verifier: AuthVerifier;
  /** Build the service for one request environment. Defaults to D1 from `env.DB`. */
  service?: (env: WorkerEnv) => Promise<SearchService>;
  logger?: Logger;
}

const MAX_BODY = 5_000_000;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const fail = (status: number, error: string) => json({ error }, status);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) throw new HttpError(413, "body is too large");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

const serviceCache = new WeakMap<object, Promise<SearchService>>();

async function defaultService(env: WorkerEnv): Promise<SearchService> {
  if (env.DB === undefined) throw new Error("the DB binding is missing");
  return createSearch({ store: new D1Index(env.DB), cursorSecret: env.SEARCH_CURSOR_SECRET ?? "" });
}

/** Build a Worker handler around an injected verifier. */
export function createWorker(opts: WorkerOptions) {
  const log: Logger = opts.logger ?? { event() {} };
  const build = opts.service ?? defaultService;

  async function route(request: Request, env: WorkerEnv, svc: () => Promise<SearchService>): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;
    if (method === "GET" && (path === "/health" || path === "/api/v1/health")) {
      return json({ ok: true, name: env.SEARCH_NAME ?? "agentic-search", version: VERSION });
    }
    if (!path.startsWith("/api/v1/")) return fail(404, "not found");

    let principal: Principal | null = null;
    try {
      principal = await opts.verifier.verify(request, env);
    } catch {
      principal = null;
    }
    if (principal === null || typeof principal !== "object") return fail(401, "unauthenticated");

    const parts = path.slice("/api/v1/".length).split("/").map(decodeURIComponent);
    const [a, b, c] = parts;
    if (parts.length === 1 && a === "search" && method === "POST") {
      return json(await (await svc()).search(principal, (await readJson(request)) as never));
    }
    if (a === "items" && parts.length === 1 && (method === "POST" || method === "PUT")) {
      const body = await readJson(request);
      const items = typeof body === "object" && body !== null && "items" in body ? (body as { items: unknown }).items : body;
      return json(await (await svc()).index(principal, items));
    }
    if (a === "items" && parts.length === 2 && method === "DELETE" && b !== undefined) {
      return json(await (await svc()).remove(principal, b));
    }
    if (a === "owners" && b !== undefined) {
      if (parts.length === 3 && c === "export" && method === "GET") {
        return json(await (await svc()).exportOwner(principal, b));
      }
      if (parts.length === 2 && method === "DELETE") {
        return json(await (await svc()).eraseOwner(principal, b));
      }
    }
    return fail(404, "not found");
  }

  return {
    async fetch(request: Request, env: WorkerEnv = {}): Promise<Response> {
      let cached: Promise<SearchService> | undefined;
      const svc = () => {
        if (opts.service !== undefined) return (cached ??= build(env));
        let p = serviceCache.get(env);
        if (p === undefined) {
          p = build(env);
          serviceCache.set(env, p);
          // Do not keep a failed build: a fixed config should work on the next request.
          p.catch(() => serviceCache.delete(env));
        }
        return p;
      };
      try {
        return await route(request, env, svc);
      } catch (error) {
        if (error instanceof HttpError) return fail(error.status, error.message);
        if (error instanceof ValidationError) return fail(400, error.message);
        if (error instanceof ForbiddenError) return fail(403, "not allowed");
        // Never echo the error text: it may hold stored data.
        log.event("worker_error", { status: 500 });
        return fail(500, "internal error");
      }
    },
  };
}

/**
 * Trial-only verifier: trusts `x-principal-id`, `x-principal-kind` and
 * `x-principal-acting-for`. Anyone can claim any identity, so it refuses to
 * work unless `SEARCH_UNSAFE_NO_AUTH=1` is set.
 */
const unsafeHeaderVerifier: AuthVerifier = {
  async verify(request, env) {
    if (env.SEARCH_UNSAFE_NO_AUTH !== "1") return null;
    const id = request.headers.get("x-principal-id");
    const kind = request.headers.get("x-principal-kind");
    if (id === null || kind === null) return null;
    const actingFor = request.headers.get("x-principal-acting-for");
    return { id, kind, ...(actingFor === null ? {} : { actingFor }) } as Principal;
  },
};

export default createWorker({ verifier: unsafeHeaderVerifier });
