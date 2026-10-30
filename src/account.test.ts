// Failure cases: foreign rows leak; bad ownership or pagination causes a partial
// erase; vectors survive a retry; shared source copies go; agent data is mislabeled;
// missing vector configuration silently leaves data; shipped export is absent.
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { searchAccount } from "./account.js";
import { MemoryIndex } from "./core/memory-index.js";
import { MemoryVectorStore } from "./core/vector.js";
import type { IndexedItem } from "./core/types.js";

const subject = { id: "ada", kind: "human" } as const;
const item = (id: string, owner = "ada"): IndexedItem => ({
  id, owner, kind: "document", title: "Title", text: "searchable words",
  resource: { type: "document", id: "shared-source" }, updatedAt: 1,
});
async function setup() {
  const store = new MemoryIndex();
  const vectors = new MemoryVectorStore(2);
  await store.upsert([item("mine"), item("theirs", "bea")]);
  await vectors.upsert([{ id: "mine", owner: "ada", vector: [1, 0] }, { id: "theirs", owner: "bea", vector: [0, 1] }]);
  return { store, vectors };
}

describe("searchAccount", () => {
  it("ships the public subpath with no Worker or React dependency", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      'import { searchAccount } from "agentic-search/account"; console.log(searchAccount.id);'], { encoding: "utf8" });
    expect(output.trim()).toBe("search");
  });

  it("exports detached JSON for only the subject, including vectors", async () => {
    const deps = await setup();
    const out = await searchAccount.exportAccount(subject, deps);
    expect(out.items).toEqual([item("mine")]);
    expect(out.vectors).toEqual([{ id: "mine", owner: "ada", vector: [1, 0] }]);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    (out.items[0] as { title: string }).title = "changed";
    expect((await deps.store.get("mine"))?.title).toBe("Title");
  });

  it("erases sole-owned index copies and preserves another owner's copy of a shared source", async () => {
    const deps = await setup();
    expect(await searchAccount.eraseAccount(subject, deps)).toEqual({ items: 1, vectors: 1 });
    expect(await deps.store.get("mine")).toBeNull();
    expect(await deps.store.get("theirs")).toEqual(item("theirs", "bea"));
    expect(await deps.vectors.listByOwner("bea", { limit: 100 })).toHaveLength(1);
    expect(await searchAccount.eraseAccount(subject, deps)).toEqual({ items: 0, vectors: 0 });
  });

  it("includes agent-owned data without inventing authorship, and accepts each principal kind", async () => {
    const deps = await setup();
    await deps.store.upsert([item("bot-copy", "bot")]);
    const agent = { id: "bot", kind: "agent" } as const;
    expect((await searchAccount.exportAccount(agent, deps)).items).toEqual([item("bot-copy", "bot")]);
    expect(await searchAccount.eraseAccount(agent, deps)).toEqual({ items: 1, vectors: 0 });
    expect(await deps.store.get("mine")).not.toBeNull();
    // Ownership is keyed by globally unique id, not principal kind.
    for (const kind of ["agent_of_human", "agent_of_agent", "user_token"] as const) {
      expect(await searchAccount.exportAccount({ id: "unused", kind }, deps)).toEqual({ items: [], vectors: [] });
    }
  });

  it("refuses damaged rows and foreign owners before deleting anything", async () => {
    for (const broken of [{ ...item("z"), updatedAt: NaN }, item("z", "bea"), { ...item("z"), owner: null }]) {
      const deps = await setup();
      vi.spyOn(deps.store, "listByOwner").mockResolvedValue([item("mine"), broken as IndexedItem]);
      await expect(searchAccount.exportAccount(subject, deps)).rejects.toThrow();
      await expect(searchAccount.eraseAccount(subject, deps)).rejects.toThrow();
      expect(await deps.store.get("mine")).not.toBeNull();
      expect(deps.vectors.size).toBe(2);
    }
  });

  it("refuses malformed vectors and non-advancing pages", async () => {
    const deps = await setup();
    vi.spyOn(deps.vectors, "listByOwner").mockResolvedValue([{ id: "mine", owner: "ada", vector: [NaN] }]);
    await expect(searchAccount.eraseAccount(subject, deps)).rejects.toThrow();
    expect(await deps.store.get("mine")).not.toBeNull();
    vi.spyOn(deps.store, "listByOwner").mockResolvedValue(Array.from({ length: 100 }, () => item("mine")));
    await expect(searchAccount.exportAccount(subject, deps)).rejects.toThrow();
  });

  it("finishes retries after vector or index deletion fails, including orphan vectors", async () => {
    const deps = await setup();
    await deps.vectors.upsert([{ id: "orphan", owner: "ada", vector: [1, 1] }]);
    const eraseVectors = vi.spyOn(deps.vectors, "removeByOwner").mockRejectedValueOnce(new Error("offline"));
    await expect(searchAccount.eraseAccount(subject, deps)).rejects.toThrow("offline");
    expect(await deps.store.get("mine")).not.toBeNull();
    const eraseItems = vi.spyOn(deps.store, "removeByOwner").mockRejectedValueOnce(new Error("offline"));
    await expect(searchAccount.eraseAccount(subject, deps)).rejects.toThrow("offline");
    expect(await deps.store.get("mine")).not.toBeNull();
    expect(await searchAccount.eraseAccount(subject, deps)).toEqual({ items: 1, vectors: 0 });
    expect(eraseVectors).toHaveBeenCalledTimes(3);
    expect(eraseItems).toHaveBeenCalledTimes(2);
    expect(await searchAccount.eraseAccount(subject, deps)).toEqual({ items: 0, vectors: 0 });
  });

  it("reads all pages and supports an explicitly lexical-only index", async () => {
    const store = new MemoryIndex();
    await store.upsert(Array.from({ length: 205 }, (_, i) => item(String(i).padStart(3, "0"))));
    const deps = { store, vectors: null };
    expect((await searchAccount.exportAccount(subject, deps)).items).toHaveLength(205);
    expect(await searchAccount.eraseAccount(subject, deps)).toEqual({ items: 205, vectors: 0 });
  });

  it("rejects bad input and an omitted vector configuration", async () => {
    const deps = await setup();
    for (const bad of [null, { id: "ada" }, { id: "", kind: "human" }, { id: "ada", kind: "robot" }]) {
      await expect(searchAccount.exportAccount(bad as never, deps)).rejects.toThrow();
      await expect(searchAccount.eraseAccount(bad as never, deps)).rejects.toThrow();
    }
    await expect(searchAccount.eraseAccount(subject, { store: deps.store } as never)).rejects.toThrow();
  });
});
