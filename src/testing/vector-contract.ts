import { describe, expect, test } from "vitest";
import type { VectorStore } from "../core/vector.js";

/** Run the vector store contract against an adapter. `make` builds an empty store of 2 dimensions. */
export function runVectorContract(name: string, make: () => Promise<VectorStore> | VectorStore): void {
  describe(`VectorStore contract: ${name}`, () => {
    const seed = async () => {
      const s = await make();
      await s.upsert([
        { id: "x", owner: "o1", vector: [1, 0] },
        { id: "y", owner: "o2", vector: [0.9, 0.1] },
        { id: "z", owner: "o2", vector: [0, 1] },
      ]);
      return s;
    };

    test("query returns nearest first, each id once, and honours the limit", async () => {
      const s = await seed();
      expect((await s.query([1, 0], 10)).map((h) => h.id)).toEqual(["x", "y", "z"]);
      expect((await s.query([1, 0], 2)).map((h) => h.id)).toEqual(["x", "y"]);
      const hits = await s.query([0.5, 0.5], 10);
      expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    });

    test("upsert replaces the vector for an id", async () => {
      const s = await seed();
      await s.upsert([{ id: "x", owner: "o1", vector: [0, 1] }]);
      expect((await s.query([0, 1], 10)).filter((h) => h.id === "x")).toHaveLength(1);
      expect((await s.query([1, 0], 1))[0]!.id).toBe("y");
    });

    test("remove drops one id and says whether it was there", async () => {
      const s = await seed();
      expect(await s.remove("x")).toBe(true);
      expect(await s.remove("x")).toBe(false);
      expect((await s.query([1, 0], 10)).map((h) => h.id)).not.toContain("x");
    });

    test("removeByOwner drops that owner's vectors and keeps the rest", async () => {
      const s = await seed();
      expect(await s.removeByOwner("o2")).toBe(2);
      expect((await s.query([1, 0], 10)).map((h) => h.id)).toEqual(["x"]);
      expect(await s.removeByOwner("o2")).toBe(0);
    });

    test("a vector of the wrong size or with a bad number is refused", async () => {
      const s = await seed();
      await expect(s.upsert([{ id: "w", owner: "o", vector: [1] }])).rejects.toThrow();
      await expect(s.upsert([{ id: "w", owner: "o", vector: [1, Number.NaN] }])).rejects.toThrow();
      await expect(s.query([1, 2, 3], 5)).rejects.toThrow();
    });
  });
}
