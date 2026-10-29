import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
      bindings: { SEARCH_CURSOR_SECRET: SECRET, SEARCH_UNSAFE_NO_AUTH: "1" },
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
      bindings: { SEARCH_UNSAFE_NO_AUTH: "1" },
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

test("migrations/0001_init.sql holds the same statements as D1_SCHEMA", () => {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const file = readFileSync("migrations/0001_init.sql", "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n");
  expect(norm(file)).toBe(norm(D1_SCHEMA.map((s) => `${s};`).join(" ")));
});
