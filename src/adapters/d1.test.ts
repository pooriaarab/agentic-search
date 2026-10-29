import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { D1Index, type D1Like } from "./d1.js";
import { runIndexContract, item } from "../testing/index-contract.js";
import { queryTerms } from "../core/text.js";

let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "search-test" },
  });
  await mf.ready;
});
afterAll(async () => {
  await mf.dispose();
});

async function freshDb(): Promise<D1Like> {
  const db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await db.batch(
    ["search_postings", "search_items"].map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)),
  );
  await D1Index.migrate(db);
  return db;
}

runIndexContract("d1 (miniflare)", async () => {
  const db = await freshDb();
  return { store: new D1Index(db), peer: () => new D1Index(db) };
});

async function postingCount(db: D1Like): Promise<number> {
  const r = await (db.prepare("SELECT COUNT(*) AS n FROM search_postings") as unknown as {
    all(): Promise<{ results: { n: number }[] }>;
  }).all();
  return r.results[0]?.n ?? -1;
}

test("remove by id leaves no posting rows behind", async () => {
  const db = await freshDb();
  const s = new D1Index(db);
  await s.upsert([item("a", { text: "secret words" })]);
  expect(await s.remove("a")).toBe(true);
  expect(await postingCount(db)).toBe(0);
});

test("a stored row with an unknown kind throws instead of being returned", async () => {
  const db = await freshDb();
  const s = new D1Index(db);
  await s.upsert([item("a", { text: "word" })]);
  await db.batch([db.prepare("UPDATE search_items SET kind = 'bogus'")]);
  await expect(s.get("a")).rejects.toThrow("not a valid item");
  await expect(s.search({ terms: ["word"], filter: {}, limit: 5 })).rejects.toThrow("not a valid item");
});

test("erase leaves no posting rows behind", async () => {
  const db = await freshDb();
  const s = new D1Index(db);
  await s.upsert([item("a", { text: "secret words" }), item("b", { text: "other" })]);
  await s.removeByOwner("u1");
  expect(await postingCount(db)).toBe(0);
  expect(await s.search({ terms: queryTerms("secret"), filter: {}, limit: 5 })).toEqual([]);
});
