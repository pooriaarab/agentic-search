import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { FileIndex } from "./local.js";
import { item, runIndexContract } from "./testing/index-contract.js";

const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "as-file-"));
  dirs.push(dir);
  return join(dir, "index.json");
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

runIndexContract("file", () => {
  const path = fresh();
  return { store: new FileIndex(path), peer: () => new FileIndex(path) };
});

test("an erase and an index that run together leave no erased item behind", async () => {
  const s = new FileIndex(fresh());
  await s.upsert([item("a")]);
  const [erased] = await Promise.all([s.removeByOwner("u1"), s.upsert([item("b", { owner: "u2" })])]);
  expect(erased).toBe(1);
  expect(await s.get("a")).toBeNull();
  expect((await s.get("b"))?.owner).toBe("u2");
});

test("a bad item in the file is a storage failure, not a usage error", async () => {
  const path = fresh();
  const s = new FileIndex(path);
  writeFileSync(path, JSON.stringify([{ id: "x", kind: "bogus" }]));
  await expect(s.get("x")).rejects.toThrow("the index file is corrupt");
});
