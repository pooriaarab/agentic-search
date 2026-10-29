import { describe, expect, test } from "vitest";
import { createSearch } from "./service.js";
import { MemoryIndex } from "./memory-index.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { encodeCursor, queryDigest } from "./cursor.js";
import type { AccessPolicy, IndexedItem, Principal } from "./types.js";
import { item } from "../testing/index-contract.js";

const alice: Principal = { id: "alice", kind: "human" };
const bob: Principal = { id: "bob", kind: "human" };

function setup(access?: AccessPolicy, extra: { maxScan?: number; logs?: unknown[] } = {}) {
  const store = new MemoryIndex();
  const logs = extra.logs;
  const svc = createSearch({
    store,
    access,
    maxScan: extra.maxScan,
    logger: logs ? { event: (name, fields) => void logs.push({ name, fields }) } : undefined,
  });
  return { store, svc };
}

const secret = (id: string, owner: string, text = "confidential merger plan"): IndexedItem =>
  item(id, { owner, title: `Secret ${id}`, text });

describe("access filter", () => {
  test("a caller sees only items the policy allows, with no leak in hits, snippets or cursor", async () => {
    const { svc } = setup();
    await svc.index(alice, [secret("a1", "alice", "merger notes for alice")]);
    await svc.index(bob, [secret("b1", "bob", "merger notes for bob, codename falcon")]);
    const page = await svc.search(alice, { query: "merger" });
    expect(page.hits.map((h) => h.id)).toEqual(["a1"]);
    const wire = JSON.stringify(page);
    expect(wire).not.toContain("falcon");
    expect(wire).not.toContain("b1");
    expect(page.nextCursor).toBeUndefined();
    expect(Object.keys(page).sort()).toEqual(["hits"]);
  });

  test("an empty page for a caller with no access looks like an empty index", async () => {
    const { svc } = setup();
    await svc.index(bob, [secret("b1", "bob")]);
    const withHidden = await svc.search(alice, { query: "merger" });
    const empty = await createSearch({ store: new MemoryIndex() }).search(alice, { query: "merger" });
    expect(withHidden).toEqual(empty);
  });

  test("pages fill with allowed items even when hidden items rank between them", async () => {
    const { svc } = setup();
    // Bob's items rank higher (more matches). Alice's rank below them.
    await svc.index(bob, Array.from({ length: 30 }, (_, i) => secret(`b${String(i).padStart(2, "0")}`, "bob", "term term term term")));
    await svc.index(alice, Array.from({ length: 5 }, (_, i) => secret(`a${i}`, "alice", "term")));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.search(alice, { query: "term", limit: 2, cursor });
      seen.push(...page.hits.map((h) => h.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });

  test("a cursor never names a hidden item", async () => {
    const { svc } = setup();
    await svc.index(bob, Array.from({ length: 10 }, (_, i) => secret(`b${i}`, "bob", "term term term")));
    await svc.index(alice, Array.from({ length: 4 }, (_, i) => secret(`a${i}`, "alice", "term")));
    const page = await svc.search(alice, { query: "term", limit: 2 });
    const decoded = Buffer.from(page.nextCursor!, "base64url").toString();
    expect(decoded).not.toMatch(/"i":"b/);
  });

  test("the scan cap bounds the work and never returns hidden items", async () => {
    const { svc } = setup(undefined, { maxScan: 20 });
    await svc.index(bob, Array.from({ length: 60 }, (_, i) => secret(`b${String(i).padStart(2, "0")}`, "bob", "term term term")));
    await svc.index(alice, [secret("a1", "alice", "term")]);
    const page = await svc.search(alice, { query: "term", limit: 5 });
    expect(page.hits).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  test("a policy answer that is not strictly true denies", async () => {
    const odd: AccessPolicy = {
      canRead: async (_p, refs) => refs.map(() => "yes" as unknown as boolean),
      canWrite: async () => true,
      canManageOwner: async () => true,
    };
    const { svc } = setup(odd);
    await svc.index(alice, [secret("a1", "alice")]);
    expect((await svc.search(alice, { query: "merger" })).hits).toEqual([]);
  });

  test("a malformed policy answer throws instead of returning unfiltered hits", async () => {
    const broken: AccessPolicy = {
      canRead: async () => [] as boolean[],
      canWrite: async () => true,
      canManageOwner: async () => true,
    };
    const { svc } = setup(broken);
    await svc.index(alice, [secret("a1", "alice")]);
    await expect(svc.search(alice, { query: "merger" })).rejects.toThrow(/malformed/);
  });

  test("a throwing policy fails the search", async () => {
    const boom: AccessPolicy = {
      canRead: async () => {
        throw new Error("backend down");
      },
      canWrite: async () => true,
      canManageOwner: async () => true,
    };
    const { svc } = setup(boom);
    await svc.index(alice, [secret("a1", "alice")]);
    await expect(svc.search(alice, { query: "merger" })).rejects.toThrow("backend down");
  });

  test("a custom policy can share items across owners", async () => {
    const shared: AccessPolicy = {
      canRead: async (p, refs) => refs.map((r) => r.owner === p.id || r.resource.id === "shared-doc"),
      canWrite: async (p, r) => r.owner === p.id,
      canManageOwner: async (p, o) => p.id === o,
    };
    const { svc } = setup(shared);
    await svc.index(bob, [item("b1", { owner: "bob", text: "roadmap", resource: { type: "doc", id: "shared-doc" } })]);
    expect((await svc.search(alice, { query: "roadmap" })).hits.map((h) => h.id)).toEqual(["b1"]);
  });

  test("an agent acts for its human and reads that human's items only", async () => {
    const { svc } = setup();
    await svc.index(alice, [secret("a1", "alice")]);
    await svc.index(bob, [secret("b1", "bob")]);
    const agent: Principal = { id: "agent-7", kind: "agent_of_human", actingFor: "alice" };
    expect((await svc.search(agent, { query: "merger" })).hits.map((h) => h.id)).toEqual(["a1"]);
  });
});

describe("principal checks", () => {
  test.each([
    [{ id: "x" }],
    [{ id: "x", kind: "root" }],
    [{ id: "", kind: "human" }],
    [{ id: "x", kind: "agent_of_human" }],
    [{ id: "x", kind: "user_token" }],
    [null],
    ["alice"],
  ])("rejects %j", async (bad) => {
    const { svc } = setup();
    await expect(svc.search(bad as unknown as Principal, { query: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.index(bad as unknown as Principal, [secret("a", "alice")])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("writes", () => {
  test("a caller cannot index for another owner", async () => {
    const { svc, store } = setup();
    await expect(svc.index(alice, [secret("x", "bob")])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await store.get("x")).toBeNull();
  });

  test("a caller cannot overwrite another owner's item by reusing its id", async () => {
    const { svc, store } = setup();
    await svc.index(bob, [secret("shared-id", "bob", "bob text")]);
    await expect(svc.index(alice, [secret("shared-id", "alice", "alice text")])).rejects.toBeInstanceOf(ForbiddenError);
    expect((await store.get("shared-id"))?.text).toBe("bob text");
  });

  test("a batch with one denied item writes nothing", async () => {
    const { svc, store } = setup();
    await expect(svc.index(alice, [secret("ok", "alice"), secret("no", "bob")])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await store.get("ok")).toBeNull();
  });

  test("remove looks the same for missing and for someone else's item", async () => {
    const { svc, store } = setup();
    await svc.index(bob, [secret("b1", "bob")]);
    expect(await svc.remove(alice, "b1")).toEqual({ removed: false });
    expect(await svc.remove(alice, "nope")).toEqual({ removed: false });
    expect(await store.get("b1")).not.toBeNull();
    expect(await svc.remove(bob, "b1")).toEqual({ removed: true });
  });

  test("invalid items are rejected", async () => {
    const { svc } = setup();
    for (const bad of [
      { ...secret("a", "alice"), kind: "video" },
      { ...secret("a", "alice"), updatedAt: Number.NaN },
      { ...secret("a", "alice"), updatedAt: "1" },
      { ...secret("a", "alice"), id: "" },
      { ...secret("a", "alice"), text: 5 },
      { ...secret("a", "alice"), resource: undefined },
    ]) {
      await expect(svc.index(alice, [bad])).rejects.toBeInstanceOf(ValidationError);
    }
  });

  test("reindex replaces the owner's items and leaves others", async () => {
    const { svc, store } = setup();
    await svc.index(alice, [secret("old1", "alice"), secret("old2", "alice")]);
    await svc.index(bob, [secret("b1", "bob")]);
    const res = await svc.reindex(alice, "alice", [secret("old2", "alice", "fresh text"), secret("new", "alice")]);
    expect(res).toEqual({ indexed: 2, removed: 1 });
    expect(await store.get("old1")).toBeNull();
    expect((await store.get("old2"))?.text).toBe("fresh text");
    expect(await store.get("b1")).not.toBeNull();
    await expect(svc.reindex(alice, "bob", [])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.reindex(alice, "alice", [secret("x", "bob")])).rejects.toBeInstanceOf(ValidationError);
    expect(await svc.reindex(alice, "alice", [])).toEqual({ indexed: 0, removed: 2 });
  });
});

describe("queries and cursors", () => {
  test("rejects empty, punctuation-only, long and bad-limit queries", async () => {
    const { svc } = setup();
    for (const req of [
      { query: "" },
      { query: "***" },
      { query: "a".repeat(501) },
      { query: Array.from({ length: 17 }, (_, i) => `w${i}`).join(" ") },
      { query: "x", limit: 0 },
      { query: "x", limit: 101 },
      { query: "x", limit: 1.5 },
      { query: "x", kinds: [] },
      { query: "x", kinds: ["video"] },
      { query: "x", updatedAfter: Number.NaN },
      { query: 5 },
    ]) {
      await expect(svc.search(alice, req as never)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  test("rejects garbage cursors and cursors from another query", async () => {
    const { svc } = setup();
    await svc.index(alice, Array.from({ length: 3 }, (_, i) => secret(`a${i}`, "alice", "term")));
    for (const cursor of ["", "%%%", "e30", Buffer.from('{"s":"x","i":"a","q":"z"}').toString("base64url")]) {
      await expect(svc.search(alice, { query: "term", cursor })).rejects.toBeInstanceOf(ValidationError);
    }
    const page = await svc.search(alice, { query: "term", limit: 1 });
    await expect(svc.search(alice, { query: "other", cursor: page.nextCursor })).rejects.toBeInstanceOf(ValidationError);
    const forged = encodeCursor({ score: Number.NaN, id: "a0" }, queryDigest({ terms: ["term"], filter: {} }));
    await expect(svc.search(alice, { query: "term", cursor: forged })).rejects.toBeInstanceOf(ValidationError);
  });

  test("hits carry highlighted snippets and title highlights", async () => {
    const { svc } = setup();
    await svc.index(alice, [item("a", { owner: "alice", title: "Budget 2026", text: "The annual budget is final." })]);
    const [hit] = (await svc.search(alice, { query: "budget" })).hits;
    expect(hit!.titleHighlights).toEqual([[0, 6]]);
    expect(hit!.snippet.text.slice(...hit!.snippet.highlights[0]!)).toBe("budget");
  });

  test("filters narrow results", async () => {
    const { svc } = setup();
    await svc.index(alice, [
      item("d", { owner: "alice", text: "x", kind: "document" }),
      item("s", { owner: "alice", text: "x", kind: "sheet" }),
    ]);
    expect((await svc.search(alice, { query: "x", kinds: ["sheet"] })).hits.map((h) => h.id)).toEqual(["s"]);
  });
});

describe("GDPR", () => {
  test("export returns exactly the owner's items; erase removes them and only them", async () => {
    const { svc, store } = setup();
    await svc.index(alice, [secret("a1", "alice"), secret("a2", "alice")]);
    await svc.index(bob, [secret("b1", "bob")]);
    const exported = await svc.exportOwner(alice, "alice");
    expect(exported.owner).toBe("alice");
    expect(exported.items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(await svc.eraseOwner(alice, "alice")).toEqual({ removed: 2 });
    expect(await store.get("a1")).toBeNull();
    expect((await svc.exportOwner(alice, "alice")).items).toEqual([]);
    expect(await store.get("b1")).not.toBeNull();
  });

  test("a caller cannot export or erase another owner", async () => {
    const { svc } = setup();
    await svc.index(bob, [secret("b1", "bob")]);
    await expect(svc.exportOwner(alice, "bob")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.eraseOwner(alice, "bob")).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("export pages past the batch size", async () => {
    const { svc } = setup();
    const many = Array.from({ length: 1_100 }, (_, i) => secret(`a${String(i).padStart(4, "0")}`, "alice"));
    for (let i = 0; i < many.length; i += 500) await svc.index(alice, many.slice(i, i + 500));
    expect((await svc.exportOwner(alice, "alice")).items).toHaveLength(1_100);
  });
});

describe("logs", () => {
  test("events hold counts only, never titles, text, ids or owners", async () => {
    const logs: unknown[] = [];
    const { svc } = setup(undefined, { logs });
    const it = item("id-zebra", { owner: "alice", title: "Title zebra", text: "text zebra" });
    await svc.index(alice, [it]);
    await svc.search(alice, { query: "zebra" });
    await svc.remove(alice, "id-zebra");
    await svc.eraseOwner(alice, "alice");
    await svc.exportOwner(alice, "alice");
    const wire = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(4);
    for (const needle of ["zebra", "alice", "id-zebra"]) expect(wire).not.toContain(needle);
  });
});
