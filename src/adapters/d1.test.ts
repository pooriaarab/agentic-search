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

test("erase leaves no posting rows behind", async () => {
  const db = await freshDb();
  const s = new D1Index(db);
  await s.upsert([item("a", { text: "secret words" }), item("b", { text: "other" })]);
  await s.removeByOwner("u1");
  const left = await (db.prepare("SELECT COUNT(*) AS n FROM search_postings") as unknown as {
    all(): Promise<{ results: { n: number }[] }>;
  }).all();
  expect(left.results[0]?.n).toBe(0);
  expect(await s.search({ terms: queryTerms("secret"), filter: {}, limit: 5 })).toEqual([]);
});
