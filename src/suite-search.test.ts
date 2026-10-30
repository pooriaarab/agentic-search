import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createSearch } from "./core/service.js";
import { MemoryIndex } from "./core/memory-index.js";
import { MemoryVectorStore } from "./core/vector.js";
import type { ItemKind, Principal } from "./core/types.js";
import { FileIndex } from "./local.js";
import { D1Index, type D1Like } from "./adapters/d1.js";
import { item } from "./testing/index-contract.js";

let mf: Miniflare;
const dir = mkdtempSync(join(tmpdir(), "search-suite-"));
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "suite-search" } });
  await mf.ready;
});
afterAll(async () => {
  await mf.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function makeStore(adapter: string, mode: string) {
  if (adapter === "memory") return new MemoryIndex();
  if (adapter === "file") return new FileIndex(join(dir, `${mode}.json`));
  const db = await mf.getD1Database("DB") as unknown as D1Like;
  await db.batch(["search_postings", "search_items"].map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
  await D1Index.migrate(db);
  return new D1Index(db);
}

// Failure cases: missing kinds, kind filters, body/title rank, cross-principal
// reads, stale grants (including a saved cursor), and hidden vector hits.
test.each([
  ["memory", "lexical"], ["memory", "hybrid"],
  ["file", "lexical"], ["file", "hybrid"],
  ["d1", "lexical"], ["d1", "hybrid"],
] as const)("%s %s search ranks all suite kinds and rechecks shares", async (adapter, mode) => {
  const store = await makeStore(adapter, mode);
  const kinds: ItemKind[] = ["document", "sheet", "slide", "table", "task", "form", "board", "file", "comment"];
  const owner: Principal = { id: "u1", kind: "human" };
  const human: Principal = { id: "reader", kind: "human" };
  const agent: Principal = { id: "reader-agent", kind: "agent" };
  const grants = new Set([human.id, agent.id]);
  const svc = await createSearch({
    store,
    cursorSecret: "suite-kind-test-secret".repeat(2),
    access: {
      async canRead(p, refs) {
        return refs.map((r) => r.owner === p.id || (grants.has(p.id) && r.resource.type === "shared"));
      },
      async canWrite(p, ref) { return p.id === ref.owner; },
      async canManageOwner(p, id) { return p.id === id; },
    },
    vectors: mode === "hybrid" ? {
      store: new MemoryVectorStore(2),
      // Title matches also have the nearest semantic vector.
      embedder: { dimensions: 2, async embed(texts) { return texts.map((t) => t.startsWith("budget") ? [1, 0] : [1, 1]); } },
    } : undefined,
  });
  const shared = kinds.flatMap((kind) => [
    item(`${kind}-title`, { kind, title: "budget", text: "notes", resource: { type: "shared", id: kind } }),
    item(`${kind}-body`, { kind, title: "notes", text: "budget", resource: { type: "shared", id: kind } }),
  ]);
  await svc.index(owner, [...shared, item("hidden", { kind: "board", title: "budget budget", text: "private budget" })]);
  for (const caller of [human, agent]) {
    for (const kind of kinds) {
      const page = await svc.search(caller, { query: "budget", kinds: [kind], mode });
      expect(page.hits.map((h) => h.id)).toEqual([`${kind}-title`, `${kind}-body`]);
    }
    const all = await svc.search(caller, { query: "budget", mode, limit: 100 });
    expect(all.hits.map((h) => h.id).sort()).toEqual(shared.map((i) => i.id).sort());
    expect(JSON.stringify(all)).not.toContain("private");
    expect(Object.keys(all)).toEqual(["hits"]);
    const first = await svc.search(caller, { query: "budget", mode, limit: 1 });
    expect(first.nextCursor).toBeTypeOf("string");
    grants.delete(caller.id);
    expect(await svc.search(caller, { query: "budget", mode })).toEqual({ hits: [] });
    expect(await svc.search(caller, { query: "budget", mode, limit: 1, cursor: first.nextCursor })).toEqual({ hits: [] });
    expect(await svc.search(owner, { query: "budget", mode, limit: 100 })).toHaveProperty("hits.length", 19);
  }
  expect(await svc.search({ id: "stranger", kind: "agent" }, { query: "budget", mode })).toEqual({ hits: [] });
}, 30_000);

