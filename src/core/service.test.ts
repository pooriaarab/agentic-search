import { describe, expect, test } from "vitest";
import { createSearch } from "./service.js";
import { MemoryIndex } from "./memory-index.js";
import { ForbiddenError, ValidationError } from "./errors.js";
import { createCursorCodec, queryDigest } from "./cursor.js";
import type { AccessPolicy, IndexedItem, Principal } from "./types.js";
import { item } from "../testing/index-contract.js";

const alice: Principal = { id: "alice", kind: "human" };
const bob: Principal = { id: "bob", kind: "human" };

const SECRET = "0123456789abcdef0123456789abcdef";

async function setup(access?: AccessPolicy, extra: { maxScan?: number; logs?: unknown[] } = {}) {
  const store = new MemoryIndex();
  const logs = extra.logs;
  const svc = await createSearch({
    store,
    cursorSecret: SECRET,
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
    const { svc } = await setup();
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
    const { svc } = await setup();
    await svc.index(bob, [secret("b1", "bob")]);
    const withHidden = await svc.search(alice, { query: "merger" });
    const emptySvc = await createSearch({ store: new MemoryIndex(), cursorSecret: SECRET });
    const empty = await emptySvc.search(alice, { query: "merger" });
    expect(withHidden).toEqual(empty);
  });

  test("refuses a bad maxScan instead of returning empty pages", async () => {
    for (const maxScan of [0, -1, Number.NaN, 1.5]) {
      await expect(createSearch({ store: new MemoryIndex(), cursorSecret: SECRET, maxScan })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  test("pages fill with allowed items even when hidden items rank between them", async () => {
    const { svc } = await setup();
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
    const { svc } = await setup();
    await svc.index(bob, Array.from({ length: 10 }, (_, i) => secret(`b${i}`, "bob", "term term term")));
    await svc.index(alice, Array.from({ length: 4 }, (_, i) => secret(`a${i}`, "alice", "term")));
    const page = await svc.search(alice, { query: "term", limit: 2 });
    const raw = Buffer.from(page.nextCursor!, "base64url").toString("latin1");
    // Sealed: neither ids nor the score are readable in the cursor.
    expect(raw).not.toMatch(/"i"|"s"|b\d|a\d/);
  });

  test("the scan cap bounds the work, then continues so no match is lost", async () => {
    const { svc } = await setup(undefined, { maxScan: 20 });
    await svc.index(bob, Array.from({ length: 60 }, (_, i) => secret(`b${String(i).padStart(2, "0")}`, "bob", "term term term")));
    await svc.index(alice, [secret("a1", "alice", "term")]);
    const first = await svc.search(alice, { query: "term", limit: 5 });
    expect(first.hits).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const seen: string[] = [];
    let cursor = first.nextCursor;
    for (let guard = 0; cursor !== undefined && guard < 20; guard++) {
      const page = await svc.search(alice, { query: "term", limit: 5, cursor });
      seen.push(...page.hits.map((h) => h.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["a1"]);
  });

  test("a policy answer that is not strictly true denies", async () => {
    const odd: AccessPolicy = {
      canRead: async (_p, refs) => refs.map(() => "yes" as unknown as boolean),
      canWrite: async () => true,
      canManageOwner: async () => true,
    };
    const { svc } = await setup(odd);
    await svc.index(alice, [secret("a1", "alice")]);
    expect((await svc.search(alice, { query: "merger" })).hits).toEqual([]);
  });

  test("a malformed policy answer throws instead of returning unfiltered hits", async () => {
    const broken: AccessPolicy = {
      canRead: async () => [] as boolean[],
      canWrite: async () => true,
      canManageOwner: async () => true,
    };
    const { svc } = await setup(broken);
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
    const { svc } = await setup(boom);
    await svc.index(alice, [secret("a1", "alice")]);
    await expect(svc.search(alice, { query: "merger" })).rejects.toThrow("backend down");
  });

  test("a custom policy can share items across owners", async () => {
    const shared: AccessPolicy = {
      canRead: async (p, refs) => refs.map((r) => r.owner === p.id || r.resource.id === "shared-doc"),
      canWrite: async (p, r) => r.owner === p.id,
      canManageOwner: async (p, o) => p.id === o,
    };
    const { svc } = await setup(shared);
    await svc.index(bob, [item("b1", { owner: "bob", text: "roadmap", resource: { type: "doc", id: "shared-doc" } })]);
    expect((await svc.search(alice, { query: "roadmap" })).hits.map((h) => h.id)).toEqual(["b1"]);
  });

  test("an agent acts for its human and reads that human's items only", async () => {
    const { svc } = await setup();
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
    [{ id: "mallory", kind: "human", actingFor: "alice" }],
    [{ id: "mallory", kind: "agent", actingFor: "alice" }],
    [null],
    ["alice"],
  ])("rejects %j", async (bad) => {
    const { svc } = await setup();
    await expect(svc.search(bad as unknown as Principal, { query: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.index(bad as unknown as Principal, [secret("a", "alice")])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("writes", () => {
  test("a caller cannot index for another owner", async () => {
    const { svc, store } = await setup();
    await expect(svc.index(alice, [secret("x", "bob")])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await store.get("x")).toBeNull();
  });

  test("a caller cannot overwrite another owner's item by reusing its id", async () => {
    const { svc, store } = await setup();
    await svc.index(bob, [secret("shared-id", "bob", "bob text")]);
    await expect(svc.index(alice, [secret("shared-id", "alice", "alice text")])).rejects.toBeInstanceOf(ForbiddenError);
    expect((await store.get("shared-id"))?.text).toBe("bob text");
  });

  test("a batch with one denied item writes nothing", async () => {
    const { svc, store } = await setup();
    await expect(svc.index(alice, [secret("ok", "alice"), secret("no", "bob")])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await store.get("ok")).toBeNull();
  });

  test("remove looks the same for missing and for someone else's item", async () => {
    const { svc, store } = await setup();
    await svc.index(bob, [secret("b1", "bob")]);
    expect(await svc.remove(alice, "b1")).toEqual({ removed: false });
    expect(await svc.remove(alice, "nope")).toEqual({ removed: false });
    expect(await store.get("b1")).not.toBeNull();
    expect(await svc.remove(bob, "b1")).toEqual({ removed: true });
  });

  test("invalid items are rejected", async () => {
    const { svc } = await setup();
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
    const { svc, store } = await setup();
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

  test("reindex takes more than one batch", async () => {
    const { svc, store } = await setup();
    const many = Array.from({ length: 1_200 }, (_, i) => secret(`a${i}`, "alice"));
    expect(await svc.reindex(alice, "alice", many)).toEqual({ indexed: 1_200, removed: 0 });
    expect(await store.get("a1199")).not.toBeNull();
  });

  test("a failed write during reindex keeps the old items", async () => {
    const { svc, store } = await setup();
    await svc.index(alice, [secret("old", "alice")]);
    store.upsert = async () => {
      throw new Error("disk full");
    };
    await expect(svc.reindex(alice, "alice", [secret("new", "alice")])).rejects.toThrow("disk full");
    expect(await store.get("old")).not.toBeNull();
  });
});

describe("queries and cursors", () => {
  test("rejects empty, punctuation-only, long and bad-limit queries", async () => {
    const { svc } = await setup();
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
    const { svc } = await setup();
    await svc.index(alice, Array.from({ length: 3 }, (_, i) => secret(`a${i}`, "alice", "term")));
    for (const cursor of ["", "%%%", "e30", Buffer.from('{"s":"x","i":"a","q":"z"}').toString("base64url")]) {
      await expect(svc.search(alice, { query: "term", cursor })).rejects.toBeInstanceOf(ValidationError);
    }
    const page = await svc.search(alice, { query: "term", limit: 1 });
    await expect(svc.search(alice, { query: "other", cursor: page.nextCursor })).rejects.toBeInstanceOf(ValidationError);
    // A cursor sealed with another secret, or edited, or made for another caller, is refused.
    const other = await createCursorCodec("ffffffffffffffffffffffffffffffff");
    const digest = await queryDigest({ terms: ["term"], filter: {}, caller: "alice", actingFor: null });
    const foreign = await other.encode({ score: 1, id: "a0" }, digest);
    await expect(svc.search(alice, { query: "term", cursor: foreign })).rejects.toBeInstanceOf(ValidationError);
    const edited = page.nextCursor!.slice(0, -2) + (page.nextCursor!.endsWith("AA") ? "BB" : "AA");
    await expect(svc.search(alice, { query: "term", cursor: edited })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.search(bob, { query: "term", cursor: page.nextCursor })).rejects.toBeInstanceOf(ValidationError);
  });

  test("a missing or short cursor secret throws at startup", async () => {
    for (const cursorSecret of [undefined, "", "short", new Uint8Array(31)]) {
      await expect(createSearch({ store: new MemoryIndex(), cursorSecret: cursorSecret as never })).rejects.toThrow(/cursorSecret/);
    }
  });

  test("hits carry highlighted snippets and title highlights", async () => {
    const { svc } = await setup();
    await svc.index(alice, [item("a", { owner: "alice", title: "Budget 2026", text: "The annual budget is final." })]);
    const [hit] = (await svc.search(alice, { query: "budget" })).hits;
    expect(hit!.titleHighlights).toEqual([[0, 6]]);
    expect(hit!.snippet.text.slice(...hit!.snippet.highlights[0]!)).toBe("budget");
  });

  test("filters narrow results", async () => {
    const { svc } = await setup();
    await svc.index(alice, [
      item("d", { owner: "alice", text: "x", kind: "document" }),
      item("s", { owner: "alice", text: "x", kind: "sheet" }),
    ]);
    expect((await svc.search(alice, { query: "x", kinds: ["sheet"] })).hits.map((h) => h.id)).toEqual(["s"]);
  });
});

describe("GDPR", () => {
  test("export returns exactly the owner's items; erase removes them and only them", async () => {
    const { svc, store } = await setup();
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
    const { svc } = await setup();
    await svc.index(bob, [secret("b1", "bob")]);
    await expect(svc.exportOwner(alice, "bob")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.eraseOwner(alice, "bob")).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("export pages past the batch size", async () => {
    const { svc } = await setup();
    const many = Array.from({ length: 1_100 }, (_, i) => secret(`a${String(i).padStart(4, "0")}`, "alice"));
    for (let i = 0; i < many.length; i += 500) await svc.index(alice, many.slice(i, i + 500));
    expect((await svc.exportOwner(alice, "alice")).items).toHaveLength(1_100);
  });
});

describe("logs", () => {
  test("events hold counts only, never titles, text, ids or owners", async () => {
    const logs: unknown[] = [];
    const { svc } = await setup(undefined, { logs });
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

describe("snippet cuts", () => {
  test("never split a grapheme", async () => {
    const family = "👨‍👩‍👧‍👦";
    const accent = "e\u0301";
    const cases = [
      "word" + "x".repeat(155) + family + "tail",
      "word" + "x".repeat(159) + accent + "tail",
      "x".repeat(300) + family.repeat(3) + " word " + "y".repeat(200) + accent.repeat(40),
      "z".repeat(120) + accent + "word" + "y".repeat(100) + family.repeat(30),
    ];
    for (const text of cases) {
      const { makeSnippet } = await import("./snippet.js");
      const out = makeSnippet(text, ["word"]).text;
      expect(out.isWellFormed()).toBe(true);
      const body = out.replace(/^…/, "").replace(/…$/, "");
      const from = text.indexOf(body);
      expect(from).toBeGreaterThanOrEqual(0);
      const cuts = new Set<number>([text.length]);
      for (const seg of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) cuts.add(seg.index);
      expect(cuts.has(from)).toBe(true);
      expect(cuts.has(from + body.length)).toBe(true);
    }
  });
});
