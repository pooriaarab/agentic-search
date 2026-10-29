import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createMemoryAuth } from "agentic-identity";
import worker, { createWorker, type AuthVerifier } from "./worker.js";
import { D1_SCHEMA, D1Index, type D1Like } from "./adapters/d1.js";
import { VERSION } from "./version.js";
import type { Principal } from "./core/types.js";

const SECRET = "s".repeat(40);
const doc = (id: string, owner: string, text: string) => ({
  id,
  kind: "document",
  title: `Title ${id}`,
  text,
  owner,
  resource: { type: "doc", id: `r-${id}` },
  updatedAt: 1000,
});

describe("worker without storage", () => {
  test("GET /health reports name and version", async () => {
    const res = await worker.fetch(new Request("http://x/health"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "agentic-search", version: VERSION });
  });

  test("unknown path is 404 and /api/v1/health works", async () => {
    expect((await worker.fetch(new Request("http://x/nope"), {})).status).toBe(404);
    expect((await worker.fetch(new Request("http://x/api/v1/health"), {})).status).toBe(200);
  });

  test("the default worker refuses every API call without the unsafe flag", async () => {
    const res = await worker.fetch(
      new Request("http://x/api/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal-id": "u1", "x-principal-kind": "human" },
        body: JSON.stringify({ query: "a" }),
      }),
      {},
    );
    expect(res.status).toBe(401);
  });

  test("bundles for a Worker runtime without Node built-ins", async () => {
    const result = await build({
      entryPoints: ["src/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
  });
});

describe("worker E2E on D1 (miniflare)", () => {
  let mf: Miniflare;
  const call = async (method: string, path: string, who: string | null, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) {
      headers["x-principal-id"] = who;
      headers["x-principal-kind"] = "human";
    }
    const res = await mf.dispatchFetch(`http://x${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["src/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      logLevel: "silent",
    });
    mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-01-01",
      d1Databases: { DB: "worker-e2e" },
      bindings: { SEARCH_CURSOR_SECRET: SECRET, SEARCH_UNSAFE_NO_AUTH: "1", SEARCH_ENV: "test" },
    });
    const db = (await mf.getD1Database("DB")) as unknown as D1Like;
    await D1Index.migrate(db);
  });
  afterAll(async () => {
    await mf.dispose();
  });

  test("index, search, delete, export and erase through the API", async () => {
    expect((await call("POST", "/api/v1/items", "u1", { items: [doc("a", "u1", "quarterly budget plan"), doc("b", "u1", "budget notes")] })).body).toEqual({ indexed: 2 });
    await call("POST", "/api/v1/items", "u2", doc("c", "u2", "private budget of someone else"));

    const mine = await call("POST", "/api/v1/search", "u1", { query: "budget" });
    expect(mine.status).toBe(200);
    expect(mine.body.hits.map((h: any) => h.id).sort()).toEqual(["a", "b"]);
    expect(JSON.stringify(mine.body)).not.toContain("someone else");

    expect((await call("DELETE", "/api/v1/items/b", "u1")).body).toEqual({ removed: true });
    expect((await call("DELETE", "/api/v1/items/c", "u1")).body).toEqual({ removed: false });
    expect((await call("POST", "/api/v1/search", "u1", { query: "budget" })).body.hits).toHaveLength(1);

    const exp = await call("GET", "/api/v1/owners/u1/export", "u1");
    expect(exp.status).toBe(200);
    expect(exp.body.items.map((i: any) => i.id)).toEqual(["a"]);

    expect((await call("GET", "/api/v1/owners/u2/export", "u1")).status).toBe(403);
    expect((await call("DELETE", "/api/v1/owners/u2", "u1")).status).toBe(403);
    expect((await call("DELETE", "/api/v1/owners/u1", "u1")).body).toEqual({ removed: 1 });
    expect((await call("POST", "/api/v1/search", "u1", { query: "budget" })).body.hits).toEqual([]);
    expect((await call("POST", "/api/v1/search", "u2", { query: "budget" })).body.hits).toHaveLength(1);
  });

  test("no principal is 401; bad input is 400; bad type is 415", async () => {
    expect((await call("POST", "/api/v1/search", null, { query: "x" })).status).toBe(401);
    expect((await call("POST", "/api/v1/search", "u1", { query: 5 })).status).toBe(400);
    expect((await call("POST", "/api/v1/items", "u1", { items: [{ id: "x" }] })).status).toBe(400);
    const res = await mf.dispatchFetch("http://x/api/v1/search", {
      method: "POST",
      headers: { "x-principal-id": "u1", "x-principal-kind": "human", "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
    const bad = await mf.dispatchFetch("http://x/api/v1/search", {
      method: "POST",
      headers: { "x-principal-id": "u1", "x-principal-kind": "human", "content-type": "application/json" },
      body: "{nope",
    });
    expect(bad.status).toBe(400);
  });

  test("a broken percent-encoding is a 400", async () => {
    expect((await call("DELETE", "/api/v1/items/%E0", "u1")).status).toBe(400);
  });

  test("an unknown principal kind is refused, never defaulted", async () => {
    const res = await mf.dispatchFetch("http://x/api/v1/search", {
      method: "POST",
      headers: { "x-principal-id": "u1", "x-principal-kind": "root", "content-type": "application/json" },
      body: JSON.stringify({ query: "budget" }),
    });
    expect(res.status).toBe(400);
  });

  test("a missing cursor secret is a 500 that does not leak details", async () => {
    const bare = new Miniflare({
      modules: true,
      script: (await build({ entryPoints: ["src/worker.ts"], bundle: true, write: false, format: "esm", platform: "neutral", conditions: ["workerd", "worker", "browser"], logLevel: "silent" })).outputFiles[0]!.text,
      compatibilityDate: "2026-01-01",
      d1Databases: { DB: "bare" },
      bindings: { SEARCH_UNSAFE_NO_AUTH: "1", SEARCH_ENV: "test" },
    });
    try {
      const res = await bare.dispatchFetch("http://x/api/v1/search", {
        method: "POST",
        headers: { "x-principal-id": "u1", "x-principal-kind": "human", "content-type": "application/json" },
        body: JSON.stringify({ query: "budget" }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
    } finally {
      await bare.dispose();
    }
  });
});

describe("injected verifier", () => {
  test("the verifier decides the principal; a throw is a 401", async () => {
    const seen: Principal[] = [];
    const verifier: AuthVerifier = {
      async verify(req) {
        const t = req.headers.get("authorization");
        if (t === "Bearer boom") throw new Error("idp down");
        if (t !== "Bearer ok") return null;
        const p: Principal = { id: "u9", kind: "human" };
        seen.push(p);
        return p;
      },
    };
    const calls: string[] = [];
    const w = createWorker({
      verifier,
      service: async () =>
        ({
          search: async (p: Principal) => (calls.push(p.id), { hits: [] }),
        }) as never,
    });
    const req = (auth?: string) =>
      new Request("http://x/api/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ query: "a" }),
      });
    expect((await w.fetch(req())).status).toBe(401);
    expect((await w.fetch(req("Bearer boom"))).status).toBe(401);
    expect((await w.fetch(req("Bearer ok"))).status).toBe(200);
    expect(calls).toEqual(["u9"]);
  });
});

describe("verified bearer tokens", () => {
  const setup = async () => {
    const ids = createMemoryAuth();
    const seen: Principal[] = [];
    const w = createWorker({
      auth: ids.auth,
      service: async () =>
        ({
          search: async (p: Principal) => (seen.push(p), { hits: [] }),
        }) as never,
    });
    const call = (headers: Record<string, string>) =>
      w.fetch(
        new Request("http://x/api/v1/search", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ query: "a" }),
        }),
        { SEARCH_UNSAFE_NO_AUTH: "1", SEARCH_ENV: "test" },
      );
    return { ids, seen, call };
  };
  const human = { principalId: "alice", kind: "human" as const, chain: [{ id: "alice", kind: "human" as const }], scopes: ["*:read"] };

  test("no token, a wrong scheme and a bad token are 401", async () => {
    const { call, seen } = await setup();
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: "Basic abc" })).status).toBe(401);
    const res = await call({ authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(seen).toEqual([]);
  });

  test("a revoked token is 401", async () => {
    const { ids, call } = await setup();
    const token = await ids.issue(human);
    expect((await call({ authorization: `Bearer ${token}` })).status).toBe(200);
    await ids.revoke(token);
    const res = await call({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(token);
  });

  test("the principal comes from the token; spoofed headers are ignored", async () => {
    const { ids, call, seen } = await setup();
    const token = await ids.issue(human);
    const res = await call({
      authorization: `Bearer ${token}`,
      "x-principal-id": "mallory",
      "x-principal-kind": "human",
      "x-principal-acting-for": "bob",
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ id: "alice", kind: "human" }]);
  });

  test("spoofed headers alone do not sign in, even in dev mode", async () => {
    const { call, seen } = await setup();
    const res = await call({ "x-principal-id": "mallory", "x-principal-kind": "human" });
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("an agent acts for the root of its chain", async () => {
    const { ids, call, seen } = await setup();
    const token = await ids.issue({
      principalId: "bot",
      kind: "agent_of_human",
      chain: [
        { id: "alice", kind: "human" },
        { id: "bot", kind: "agent_of_human" },
      ],
      scopes: ["*:read"],
    });
    expect((await call({ authorization: `Bearer ${token}` })).status).toBe(200);
    expect(seen).toEqual([{ id: "bot", kind: "agent_of_human", actingFor: "alice" }]);
  });

  test("a good token of a refused kind or without the scope is 403", async () => {
    const ids = createMemoryAuth();
    const token = await ids.issue(human);
    const send = (require: { kinds?: ("agent" | "human")[] }) =>
      createWorker({ auth: ids.auth, require, service: async () => ({ search: async () => ({ hits: [] }) }) as never }).fetch(
        new Request("http://x/api/v1/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ query: "a" }),
        }),
        {},
      );
    expect((await send({ kinds: ["agent"] })).status).toBe(403);
    expect((await send({ kinds: ["human"] })).status).toBe(200);
  });

  test("a *:read token can search but gets 403 on index, remove and erase", async () => {
    const { ids } = await setup();
    const w = createWorker({
      auth: ids.auth,
      service: async () => ({ search: async () => ({ hits: [] }), exportOwner: async () => ({}) }) as never,
    });
    const token = await ids.issue(human);
    const send = (method: string, path: string) =>
      w.fetch(
        new Request(`http://x/api/v1${path}`, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: method === "GET" || method === "DELETE" ? undefined : "{}",
        }),
        {},
      );
    expect((await send("POST", "/search")).status).toBe(200);
    expect((await send("GET", "/owners/alice/export")).status).toBe(200);
    expect((await send("PUT", "/items")).status).toBe(403);
    expect((await send("POST", "/items")).status).toBe(403);
    expect((await send("DELETE", "/items/x")).status).toBe(403);
    expect((await send("DELETE", "/owners/alice")).status).toBe(403);
    // Encoded segments decode to the same routes, so they need the same scopes.
    for (const [m, path] of [
      ["POST", "/%69tems"],
      ["PUT", "/%69%74ems"],
      ["DELETE", "/%69tems/x"],
      ["DELETE", "/%6Fwners/alice"],
      ["DELETE", "/%6fwners/alice"],
    ] as const) {
      expect((await send(m, path)).status, `${m} ${path}`).toBe(403);
    }
    expect((await send("POST", "/%zz")).status).toBe(400);
  });

  test("an auth builder that throws is a 500 and logs no detail", async () => {
    const events: string[] = [];
    const w = createWorker({
      auth: () => {
        throw new Error("no keys");
      },
      logger: { event: (n, f) => events.push(`${n}:${JSON.stringify(f)}`) },
    });
    const res = await w.fetch(
      new Request("http://x/api/v1/search", { method: "POST", headers: { authorization: "Bearer x" } }),
      {},
    );
    expect(res.status).toBe(500);
    expect(events).toEqual(['auth_error:{"status":500}']);
  });

  test("a function auth builds once per env", async () => {
    const ids = createMemoryAuth();
    let builds = 0;
    const w = createWorker({ auth: () => (builds++, ids.auth) });
    const env = {};
    for (let i = 0; i < 3; i++) await w.fetch(new Request("http://x/api/v1/search", { method: "POST" }), env);
    expect(builds).toBe(1);
  });

  test("two Workers on one env never share a built Auth", async () => {
    const a = createMemoryAuth();
    const b = createMemoryAuth();
    const token = await a.issue(human);
    const service = async () => ({ search: async () => ({ hits: [] }) }) as never;
    const wa = createWorker({ auth: () => a.auth, service });
    const wb = createWorker({ auth: () => b.auth, service });
    const env = {};
    const req = () =>
      new Request("http://x/api/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
      });
    expect((await wa.fetch(req(), env)).status).toBe(200);
    expect((await wb.fetch(req(), env)).status).toBe(401);
  });

  test("createWorker needs exactly one of auth and verifier", () => {
    expect(() => createWorker({})).toThrow();
    expect(() => createWorker({ auth: createMemoryAuth().auth, verifier: { verify: async () => null } })).toThrow();
  });
});

describe("dev mode header trust", () => {
  const call = (env: Record<string, string>) =>
    worker.fetch(
      new Request("http://x/api/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-principal-id": "u1", "x-principal-kind": "human" },
        body: "{}",
      }),
      env,
    );
  test("fails closed when SEARCH_ENV is production, unset or unknown", async () => {
    for (const env of ["production", "prod", "Production", undefined]) {
      const bindings: Record<string, string> = { SEARCH_UNSAFE_NO_AUTH: "1" };
      if (env !== undefined) bindings.SEARCH_ENV = env;
      expect((await call(bindings)).status).toBe(401);
    }
  });
  test("works with the flag and SEARCH_ENV=development", async () => {
    // No DB is bound, so a passed sign-in ends at the missing binding (500), never at 401.
    // The D1 tests above run the full header path and check the data.
    expect((await call({ SEARCH_UNSAFE_NO_AUTH: "1", SEARCH_ENV: "development" })).status).toBe(500);
  });
  test("is off without the flag", async () => {
    expect((await call({})).status).toBe(401);
  });
});

test("migrations/0001_init.sql holds the same statements as D1_SCHEMA", () => {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const file = readFileSync("migrations/0001_init.sql", "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n");
  expect(norm(file)).toBe(norm(D1_SCHEMA.map((s) => `${s};`).join(" ")));
});
