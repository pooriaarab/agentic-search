import { afterEach, describe, expect, test } from "vitest";
import type { IndexedItem, IndexStore, StoreQuery } from "../core/types.js";
import { queryTerms } from "../core/text.js";

export interface ContractHarness {
  store: IndexStore;
  /** A second store instance on the same backing data. Used to test concurrent writers. */
  peer(): IndexStore;
  close?(): Promise<void> | void;
}

export function item(id: string, over: Partial<IndexedItem> = {}): IndexedItem {
  return {
    id,
    kind: "document",
    title: `Title ${id}`,
    text: `Body ${id}`,
    owner: "u1",
    resource: { type: "doc", id: `r-${id}` },
    updatedAt: 1_000,
    ...over,
  };
}

function q(query: string, over: Partial<StoreQuery> = {}): StoreQuery {
  return { terms: queryTerms(query), filter: {}, limit: 50, ...over };
}

async function ids(store: IndexStore, query: StoreQuery): Promise<string[]> {
  return (await store.search(query)).map((h) => h.item.id);
}

/** Run the index store contract against an adapter. */
export function runIndexContract(name: string, make: () => Promise<ContractHarness> | ContractHarness): void {
  describe(`IndexStore contract: ${name}`, () => {
    let h: ContractHarness;
    const setup = async () => {
      h = await make();
      return h.store;
    };
    afterEach(async () => {
      await h?.close?.();
    });

    test("upsert then get round-trips every field", async () => {
      const s = await setup();
      const it = item("a", { title: "Plan", text: "Quarterly plan", kind: "sheet", updatedAt: 42 });
      await s.upsert([it]);
      expect(await s.get("a")).toEqual(it);
      expect(await s.get("missing")).toBeNull();
    });

    test("upsert replaces: old text stops matching and no duplicate hit appears", async () => {
      const s = await setup();
      await s.upsert([item("a", { text: "alpha beta" })]);
      await s.upsert([item("a", { text: "gamma delta" })]);
      expect(await ids(s, q("alpha"))).toEqual([]);
      expect(await ids(s, q("gamma"))).toEqual(["a"]);
    });

    test("terms are ANDed, last term is a prefix, case and accents fold", async () => {
      const s = await setup();
      await s.upsert([
        item("a", { text: "Budget review for Zürich office" }),
        item("b", { text: "Budget only" }),
      ]);
      expect(await ids(s, q("budget zurich"))).toEqual(["a"]);
      expect(await ids(s, q("BUDGET offi"))).toEqual(["a"]);
      expect(await ids(s, q("budg"))).toHaveLength(2);
      expect((await ids(s, q("budget missing")))).toEqual([]);
    });

    test("a first term is not a prefix", async () => {
      const s = await setup();
      await s.upsert([item("a", { text: "budget review" })]);
      expect(await ids(s, q("budg review"))).toEqual([]);
    });

    test("more occurrences rank higher", async () => {
      const s = await setup();
      await s.upsert([
        item("one", { title: "n", text: "cat dog bird fish" }),
        item("many", { title: "n", text: "cat cat cat fish" }),
      ]);
      expect((await ids(s, q("cat")))[0]).toBe("many");
    });

    test("a title match outranks a text match", async () => {
      const s = await setup();
      await s.upsert([
        item("text", { title: "notes", text: "roadmap" }),
        item("title", { title: "roadmap", text: "notes" }),
      ]);
      expect((await ids(s, q("roadmap")))[0]).toBe("title");
    });

    test("filters: kinds, owner, resource, time range", async () => {
      const s = await setup();
      await s.upsert([
        item("a", { text: "x", kind: "document", owner: "u1", updatedAt: 100, resource: { type: "doc", id: "d1" } }),
        item("b", { text: "x", kind: "sheet", owner: "u2", updatedAt: 200, resource: { type: "sheet", id: "s1" } }),
        item("c", { text: "x", kind: "comment", owner: "u1", updatedAt: 300, resource: { type: "doc", id: "d1" } }),
      ]);
      const sorted = async (f: StoreQuery["filter"]) => (await ids(s, q("x", { filter: f }))).sort();
      expect(await sorted({ kinds: ["sheet", "comment"] })).toEqual(["b", "c"]);
      expect(await sorted({ owner: "u1" })).toEqual(["a", "c"]);
      expect(await sorted({ resource: { type: "doc" } })).toEqual(["a", "c"]);
      expect(await sorted({ resource: { type: "doc", id: "d1" }, owner: "u1", kinds: ["comment"] })).toEqual(["c"]);
      expect(await sorted({ updatedAfter: 100 })).toEqual(["b", "c"]);
      expect(await sorted({ updatedBefore: 300 })).toEqual(["a", "b"]);
      expect(await sorted({ updatedAfter: 100, updatedBefore: 300 })).toEqual(["b"]);
    });

    test("keyset pagination visits every hit once, in a stable order", async () => {
      const s = await setup();
      const all = Array.from({ length: 7 }, (_, i) => item(`i${i}`, { text: `word ${"word ".repeat(i)}` }));
      await s.upsert(all);
      const full = await ids(s, q("word"));
      expect(full).toHaveLength(7);
      const seen: string[] = [];
      let after: StoreQuery["after"];
      for (let guard = 0; guard < 10; guard++) {
        const page = await s.search(q("word", { limit: 3, after }));
        if (page.length === 0) break;
        seen.push(...page.map((p) => p.item.id));
        const last = page[page.length - 1]!;
        after = { score: last.score, id: last.item.id };
      }
      expect(seen).toEqual(full);
    });

    test("equal scores break ties by id ascending", async () => {
      const s = await setup();
      await s.upsert([item("b", { title: "t", text: "same" }), item("a", { title: "t", text: "same" })]);
      expect(await ids(s, q("same"))).toEqual(["a", "b"]);
    });

    test("remove and removeByOwner", async () => {
      const s = await setup();
      await s.upsert([item("a", { text: "k" }), item("b", { text: "k", owner: "u2" }), item("c", { text: "k", owner: "u2" })]);
      expect(await s.remove("a")).toBe(true);
      expect(await s.remove("a")).toBe(false);
      expect(await s.get("a")).toBeNull();
      expect(await s.removeByOwner("u2")).toBe(2);
      expect(await ids(s, q("k"))).toEqual([]);
      expect(await s.removeByOwner("u2")).toBe(0);
    });

    test("listByOwner pages by id and only lists that owner", async () => {
      const s = await setup();
      await s.upsert([item("c"), item("a"), item("b"), item("z", { owner: "u2" })]);
      const first = await s.listByOwner("u1", { limit: 2 });
      expect(first.map((i) => i.id)).toEqual(["a", "b"]);
      const next = await s.listByOwner("u1", { limit: 2, after: "b" });
      expect(next.map((i) => i.id)).toEqual(["c"]);
    });

    test("odd characters in text and terms do not break the query", async () => {
      const s = await setup();
      await s.upsert([item("a", { text: 'say "hello" AND (world) OR * NEAR' })]);
      expect(await ids(s, q('"hello"'))).toEqual(["a"]);
      expect(await ids(s, q("and"))).toEqual(["a"]);
      expect(await ids(s, q("near"))).toEqual(["a"]);
    });

    test("two writers on the same data leave one coherent row per id", async () => {
      const s = await setup();
      const p = h.peer();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => [
          s.upsert([item("x", { text: `first${i} shared` })]),
          p.upsert([item("x", { text: `second${i} shared` })]),
        ]).flat(),
      );
      const hits = await s.search(q("shared"));
      expect(hits).toHaveLength(1);
      const stored = await s.get("x");
      expect(stored?.text).toBe(hits[0]!.item.text);
      // The text the index finds is the text the store holds: no stale index rows.
      const word = stored!.text.split(" ")[0]!;
      expect(await ids(s, q(word))).toEqual(["x"]);
      const other = word.startsWith("first") ? "second" : "first";
      expect(await ids(s, q(other))).toEqual([]);
    });
  });
}
