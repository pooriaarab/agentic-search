import { describe, expect, test } from "vitest";
import { createSearch } from "./service.js";
import { MemoryIndex } from "./memory-index.js";
import { ValidationError } from "./errors.js";
import { MemoryVectorStore, reciprocalRankFusion, type Embedder, type HybridRanker } from "./vector.js";
import { item, runVectorContract } from "../testing/index-contract.js";
import type { Principal } from "./types.js";

const SECRET = "x".repeat(40);
const u1: Principal = { id: "u1", kind: "human" };
const u2: Principal = { id: "u2", kind: "human" };

// Three concepts: money, animal, space. A text's vector counts its concept words.
const CONCEPTS = [["budget", "invoice", "cost", "money"], ["cat", "dog", "pet"], ["moon", "star", "orbit"]];
const fakeEmbedder: Embedder = {
  dimensions: 3,
  async embed(texts) {
    return texts.map((t) => {
      const words = t.toLowerCase().split(/\W+/);
      const v = CONCEPTS.map((c) => words.filter((w) => c.includes(w)).length);
      return v.every((n) => n === 0) ? [0.001, 0.001, 0.001] : v;
    });
  },
};

async function make(over: { rank?: HybridRanker; embedder?: Embedder; depth?: number } = {}) {
  const store = new MemoryIndex();
  const vectors = new MemoryVectorStore(3);
  const svc = await createSearch({
    store,
    cursorSecret: SECRET,
    vectors: { embedder: over.embedder ?? fakeEmbedder, store: vectors, rank: over.rank, depth: over.depth },
  });
  return { svc, store, vectors };
}

const ids = (page: { hits: { id: string }[] }) => page.hits.map((h) => h.id);

describe("hybrid search", () => {
  test("finds an item by meaning when no word matches", async () => {
    const { svc } = await make();
    await svc.index(u1, [item("inv", { title: "Q3", text: "invoice list" }), item("pet", { title: "Q4", text: "dog and cat" })]);
    const page = await svc.search(u1, { query: "cost" });
    expect(ids(page)[0]).toBe("inv");
    expect(await svc.search(u1, { query: "cost", mode: "lexical" })).toEqual({ hits: [] });
  });

  test("a hidden item never shows up, even when it is the nearest vector", async () => {
    const { svc } = await make();
    await svc.index(u2, [item("secret", { owner: "u2", title: "money", text: "money money cost cost budget" })]);
    await svc.index(u1, [item("mine", { title: "x", text: "invoice" })]);
    const page = await svc.search(u1, { query: "money cost" });
    expect(ids(page)).toEqual(["mine"]);
    expect(JSON.stringify(page)).not.toContain("secret");
  });

  test("hidden items do not change the order the caller sees", async () => {
    const a = await make();
    const b = await make();
    const mine = [item("p", { text: "money cost" }), item("q", { text: "money" }), item("r", { text: "cost invoice invoice" })];
    await a.svc.index(u1, mine);
    await b.svc.index(u1, mine);
    await b.svc.index(u2, Array.from({ length: 15 }, (_, i) => item(`h${i}`, { owner: "u2", text: `money cost ${"budget ".repeat(i)}` })));
    expect(ids(await b.svc.search(u1, { query: "money cost" }))).toEqual(ids(await a.svc.search(u1, { query: "money cost" })));
  });

  test("the ranker sees only readable ids, and an id it invents is an error", async () => {
    const seen: string[][] = [];
    const { svc } = await make({
      rank: ({ lexical, vector }) => {
        seen.push([...lexical, ...vector].map((r) => r.id));
        return [...lexical, ...vector, { id: "secret", score: 9 }];
      },
    });
    await svc.index(u2, [item("secret", { owner: "u2", text: "money" })]);
    await svc.index(u1, [item("mine", { text: "money" })]);
    await expect(svc.search(u1, { query: "money" })).rejects.toThrow("not given");
    expect(seen[0]?.every((id) => id === "mine")).toBe(true);
  });

  test("pages by cursor, once each, and a cursor from another query is refused", async () => {
    const { svc } = await make();
    await svc.index(u1, Array.from({ length: 7 }, (_, i) => item(`i${i}`, { text: `money ${"cost ".repeat(i)}` })));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 5; n++) {
      const page = await svc.search(u1, { query: "money", limit: 3, cursor });
      seen.push(...ids(page));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `i${i}`));
    const first = await svc.search(u1, { query: "money", limit: 2 });
    await expect(svc.search(u1, { query: "cost", limit: 2, cursor: first.nextCursor })).rejects.toThrow(ValidationError);
  });

  test("the filter applies to vector hits too", async () => {
    const { svc } = await make();
    await svc.index(u1, [item("d", { kind: "document", text: "invoice" }), item("s", { kind: "sheet", text: "invoice" })]);
    expect(ids(await svc.search(u1, { query: "cost", kinds: ["sheet"] }))).toEqual(["s"]);
  });

  test("mode hybrid without vectors is a validation error", async () => {
    const svc = await createSearch({ store: new MemoryIndex(), cursorSecret: SECRET });
    await expect(svc.search(u1, { query: "a", mode: "hybrid" })).rejects.toThrow(ValidationError);
  });
});

describe("vectors and erase", () => {
  test("remove, eraseOwner and reindex drop the vectors too", async () => {
    const { svc, vectors } = await make();
    await svc.index(u1, [item("a", { text: "money" }), item("b", { text: "dog" }), item("c", { text: "moon" })]);
    expect(vectors.size).toBe(3);
    await svc.remove(u1, "a");
    expect(vectors.size).toBe(2);
    await svc.reindex(u1, "u1", [item("b", { text: "dog" })]);
    expect(vectors.size).toBe(1);
    await svc.eraseOwner(u1, "u1");
    expect(vectors.size).toBe(0);
  });

  test("a failing embedder stops the call before anything is written", async () => {
    const { svc, store, vectors } = await make({ embedder: { dimensions: 3, embed: async () => { throw new Error("down"); } } });
    await expect(svc.index(u1, [item("a")])).rejects.toThrow("down");
    expect(await store.get("a")).toBeNull();
    expect(vectors.size).toBe(0);
  });

  test("a bad vector from the embedder is refused", async () => {
    for (const out of [[[1, 2]], [[1, 2, Number.NaN]], []]) {
      const { svc, store } = await make({ embedder: { dimensions: 3, embed: async () => out as number[][] } });
      await expect(svc.index(u1, [item("a")])).rejects.toThrow();
      expect(await store.get("a")).toBeNull();
    }
  });

  test("a failing embedder fails the search instead of falling back to words", async () => {
    const { svc } = await make();
    await svc.index(u1, [item("a", { text: "money" })]);
    const down: Embedder = { dimensions: 3, embed: async () => { throw new Error("down"); } };
    const store = new MemoryIndex();
    const broken = await createSearch({ store, cursorSecret: SECRET, vectors: { embedder: down, store: new MemoryVectorStore(3) } });
    await expect(broken.search(u1, { query: "money" })).rejects.toThrow("down");
  });
});

runVectorContract("memory", () => new MemoryVectorStore(2));

describe("the default ranker", () => {
  test("fusion rewards a hit that is in both lists", () => {
    const out = reciprocalRankFusion()({
      lexical: [{ id: "a", score: 5 }, { id: "b", score: 4 }],
      vector: [{ id: "c", score: 1 }, { id: "b", score: 0.9 }],
    });
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});

describe("review cases", () => {
  test("a cursor past depth still works when word and vector sides hold different ids", async () => {
    const split: Embedder = {
      dimensions: 3,
      embed: async (t) => t.map((x) => (x.includes("invoice") || x === "zebra" ? [1, 0, 0] : [0, 1, 0])),
    };
    const { svc } = await make({ depth: 3, embedder: split });
    await svc.index(u1, [
      ...[0, 1, 2].map((i) => item(`w${i}`, { text: `zebra ${"zebra ".repeat(3 - i)}` })),
      ...[0, 1, 2].map((i) => item(`v${i}`, { text: `invoice ${"invoice ".repeat(3 - i)}` })),
    ]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 6; n++) {
      const page = await svc.search(u1, { query: "zebra", limit: 2, cursor });
      seen.push(...ids(page));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toHaveLength(6);
  });

  test("a failed vector delete is retried by the next remove and reindex", async () => {
    const { svc, vectors } = await make();
    await svc.index(u1, [item("a", { text: "money" }), item("b", { text: "dog" })]);
    const real = vectors.remove.bind(vectors);
    let fail = true;
    vectors.remove = async (id) => {
      if (fail) throw new Error("vector store down");
      return real(id);
    };
    await expect(svc.remove(u1, "a")).rejects.toThrow("down");
    await expect(svc.reindex(u1, "u1", [])).rejects.toThrow("down");
    fail = false;
    expect(await svc.remove(u1, "a")).toEqual({ removed: true });
    await svc.reindex(u1, "u1", []);
    expect(vectors.size).toBe(0);
  });

  test("more hidden vectors than depth do not empty the readable side", async () => {
    const { svc } = await make({ depth: 5 });
    await svc.index(u2, Array.from({ length: 12 }, (_, i) => item(`h${i}`, { owner: "u2", text: `money money money ${"cost ".repeat(i)}` })));
    await svc.index(u1, [item("mine", { text: "invoice dog" })]);
    expect(ids(await svc.search(u1, { query: "money" }))).toEqual(["mine"]);
  });

  test("a bad minScore and a bad vector hit are refused", async () => {
    await expect(createSearch({ store: new MemoryIndex(), cursorSecret: SECRET, vectors: { embedder: fakeEmbedder, store: new MemoryVectorStore(3), minScore: Number.NaN } })).rejects.toThrow(ValidationError);
    const vstore = new MemoryVectorStore(3);
    vstore.query = async () => [{ id: "a", score: Number.NaN }];
    const svc = await createSearch({ store: new MemoryIndex(), cursorSecret: SECRET, vectors: { embedder: fakeEmbedder, store: vstore } });
    await expect(svc.search(u1, { query: "money" })).rejects.toThrow("bad hit");
  });

  test("a vector store that repeats an id is refused", async () => {
    const vstore = new MemoryVectorStore(3);
    vstore.query = async () => [{ id: "a", score: 0.9 }, { id: "a", score: 0.8 }];
    const svc = await createSearch({ store: new MemoryIndex(), cursorSecret: SECRET, vectors: { embedder: fakeEmbedder, store: vstore } });
    await expect(svc.search(u1, { query: "money" })).rejects.toThrow("twice");
  });

  test("reindex embeds in batches", async () => {
    const sizes: number[] = [];
    const embedder: Embedder = { dimensions: 3, embed: async (t) => (sizes.push(t.length), t.map(() => [1, 0, 0])) };
    const { svc } = await make({ embedder });
    await svc.reindex(u1, "u1", Array.from({ length: 1200 }, (_, i) => item(`b${i}`)));
    expect(sizes).toEqual([500, 500, 200]);
  });
});
