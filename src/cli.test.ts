import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runCli } from "./cli-core.js";
import { VERSION } from "./version.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "as-cli-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const doc = (id: string, owner: string, text: string) => ({
  id, kind: "document", title: `Title ${id}`, text, owner, resource: { type: "doc", id }, updatedAt: 9,
});
const run = async (args: string[], who = ["--as", "u1", "--kind", "human"]) => {
  const c = capture();
  const code = await runCli([...args, "--data", join(dir, "d"), ...who], c.io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
};

test("--version prints the version", async () => {
  const c = capture();
  expect(await runCli(["--version"], c.io)).toBe(0);
  expect(c.out).toEqual([VERSION]);
});

test("no args prints help", async () => {
  const c = capture();
  expect(await runCli([], c.io)).toBe(0);
  expect(c.out[0]).toContain("Usage: agentic-search");
});

test("unknown command exits 2", async () => {
  const c = capture();
  expect(await runCli(["nope"], c.io)).toBe(2);
  expect(c.err[0]).toContain("nope");
});

test("index, search, remove, export and erase against the local index", async () => {
  const file = join(dir, "items.json");
  writeFileSync(file, JSON.stringify([doc("a", "u1", "quarterly budget"), doc("b", "u1", "budget notes")]));
  expect(JSON.parse((await run(["index", file])).out)).toEqual({ indexed: 2 });

  const found = await run(["search", "budget", "--json", "--limit", "1"]);
  const page = JSON.parse(found.out);
  expect(page.hits).toHaveLength(1);
  expect(page.nextCursor).toBeTypeOf("string");
  const next = JSON.parse((await run(["search", "budget", "--json", "--limit", "1", "--cursor", page.nextCursor])).out);
  expect(next.hits[0].id).not.toBe(page.hits[0].id);

  const text = await run(["search", "quarterly"]);
  expect(text.out).toContain("document\ta\tTitle a");

  // Another caller sees nothing of u1's data and cannot erase or export it.
  const other = ["--as", "u2", "--kind", "human"];
  expect(JSON.parse((await run(["search", "budget", "--json"], other)).out).hits).toEqual([]);
  expect((await run(["export", "u1"], other)).code).toBe(3);
  expect((await run(["erase", "u1"], other)).code).toBe(3);

  expect(JSON.parse((await run(["remove", "b"])).out)).toEqual({ removed: true });
  expect(JSON.parse((await run(["export", "u1"])).out).items.map((i: { id: string }) => i.id)).toEqual(["a"]);
  expect(JSON.parse((await run(["erase", "u1"])).out)).toEqual({ removed: 1 });
  // The file holds no copy after erase.
  expect(readFileSync(join(dir, "d", "index.json"), "utf8")).toBe("[]");
});

test("a missing principal kind exits 2 and never defaults", async () => {
  const r = await run(["search", "x"], ["--as", "u1"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("principal");
});

test("a corrupt index file fails the call instead of reading as empty", async () => {
  writeFileSync(join(dir, "d", "index.json"), "{not json");
  const r = await run(["search", "budget"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("failed");
  writeFileSync(join(dir, "d", "index.json"), "[]");
});

test("bad flags and bad input are usage errors", async () => {
  expect((await run(["search", "x", "--bogus", "1"])).code).toBe(2);
  expect((await run(["search", "x", "--limit", "abc"])).code).toBe(2);
  expect((await run(["search"])).code).toBe(2);
  expect((await run(["search", "x", "--resource-id", "r1"])).code).toBe(2);
  expect((await run(["remove", "a", "b"])).code).toBe(2);
  expect((await run(["search", "--help"])).code).toBe(0);
  writeFileSync(join(dir, "bad.json"), "{");
  expect((await run(["index", join(dir, "bad.json")])).code).toBe(2);
});

test("a query of several words searches all of them; -- ends flags", async () => {
  const file = join(dir, "multi.json");
  writeFileSync(file, JSON.stringify([doc("m1", "u1", "quarterly budget"), doc("m2", "u1", "quarterly notes")]));
  await run(["index", file]);
  const r = await run(["search", "quarterly", "budget", "--json"]);
  expect(JSON.parse(r.out).hits.map((h: { id: string }) => h.id)).toEqual(["m1"]);
  const c = capture();
  await runCli(["search", "--data", join(dir, "d"), "--as", "u1", "--kind", "human", "--json", "--", "--quarterly"], c.io);
  // After "--" the word is a query, not an unknown flag.
  expect(JSON.parse(c.out.join("")).hits).toHaveLength(2);
});
