import { requirePrincipal, type RequirePrincipalOptions } from "agentic-identity/http";
import type { Auth, PrincipalContext } from "agentic-identity";
import { createSearch, type SearchService } from "./core/service.js";
import { ForbiddenError, ValidationError } from "./core/errors.js";
import { D1Index, type D1Like } from "./adapters/d1.js";
import type { AccessPolicy, Logger, Principal } from "./core/types.js";
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
  /** Set to "production" to make the header-trust dev mode refuse, even with the flag set. */
  SEARCH_ENV?: string;
}

/** The bearer-token verifier, or a function that builds it for one request environment. */
export type AuthSource = Auth | ((env: WorkerEnv) => Auth | Promise<Auth>);

export interface WorkerOptions {
  /**
   * Verifies bearer tokens with `agentic-identity/http`. A missing or bad token is a 401. The principal
   * comes from the verified token and never from request headers. Give `auth` or `verifier`, not both.
   */
  auth?: AuthSource;
  /** Extra checks for `auth`: `kinds`, `scope` and `origins`. A token that falls short gets a 403. */
  require?: RequirePrincipalOptions;
  /** Custom verification. Give `auth` or `verifier`, not both. */
  verifier?: AuthVerifier;
  /** Build the service for one request environment. Defaults to D1 from `env.DB`. */
  service?: (env: WorkerEnv) => Promise<SearchService>;
  logger?: Logger;
  /** Access policy for the default service. Defaults to owner-only. */
  access?: AccessPolicy;
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
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) throw new HttpError(413, "body is too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

const serviceCache = new WeakMap<object, Promise<SearchService>>();

/**
 * Map a verified token to a search principal. The subject is the root of the chain, so an agent
 * reads what the person it acts for may read. A `human` or `agent` carries no `actingFor`.
 */
export function principalFromContext(context: PrincipalContext): Principal {
  const root = context.chain[0];
  const principal: Principal = { id: context.principalId, kind: context.kind };
  if (context.kind !== "human" && context.kind !== "agent") {
    if (root === undefined) throw new Error("the principal chain is empty");
    principal.actingFor = root.id;
  }
  return principal;
}

/** Build a Worker handler around `auth` (verified bearer tokens) or an injected verifier. */
export function createWorker(opts: WorkerOptions) {
  if ((opts.auth === undefined) === (opts.verifier === undefined)) {
    throw new Error("createWorker needs exactly one of `auth` or `verifier`");
  }
  const log: Logger = opts.logger ?? { event() {} };
  const build =
    opts.service ??
    (async (env: WorkerEnv) => {
      if (env.DB === undefined) throw new Error("the DB binding is missing");
      return createSearch({
        store: new D1Index(env.DB),
        cursorSecret: env.SEARCH_CURSOR_SECRET ?? "",
        access: opts.access,
        logger: opts.logger,
      });
    });

  async function route(request: Request, env: WorkerEnv, svc: () => Promise<SearchService>): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;
    if (method === "GET" && (path === "/health" || path === "/api/v1/health")) {
      return json({ ok: true, name: env.SEARCH_NAME ?? "agentic-search", version: VERSION });
    }
    if (!path.startsWith("/api/v1/")) return fail(404, "not found");

    let principal: Principal | null = null;
    if (opts.auth !== undefined) {
      try {
        const auth = typeof opts.auth === "function" ? await opts.auth(env) : opts.auth;
        const result = await requirePrincipal(request, auth, opts.require);
        if (result instanceof Response) return result;
        principal = principalFromContext(result);
      } catch {
        principal = null;
      }
    } else {
      try {
        principal = await opts.verifier!.verify(request, env);
      } catch {
        principal = null;
      }
    }
    if (principal === null || typeof principal !== "object") return fail(401, "unauthenticated");

    let parts: string[];
    try {
      parts = path.slice("/api/v1/".length).split("/").map(decodeURIComponent);
    } catch {
      return fail(400, "path is not valid percent-encoding");
    }
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
 * Dev-mode verifier: trusts `x-principal-id`, `x-principal-kind` and
 * `x-principal-acting-for`. Anyone can claim any identity, so it refuses to
 * work unless `SEARCH_UNSAFE_NO_AUTH=1` is set, and it always refuses when
 * `SEARCH_ENV=production`.
 */
const unsafeHeaderVerifier: AuthVerifier = {
  async verify(request, env) {
    if (env.SEARCH_UNSAFE_NO_AUTH !== "1" || env.SEARCH_ENV === "production") return null;
    const id = request.headers.get("x-principal-id");
    const kind = request.headers.get("x-principal-kind");
    if (id === null || kind === null) return null;
    const actingFor = request.headers.get("x-principal-acting-for");
    return { id, kind, ...(actingFor === null ? {} : { actingFor }) } as Principal;
  },
};

export default createWorker({ verifier: unsafeHeaderVerifier });
