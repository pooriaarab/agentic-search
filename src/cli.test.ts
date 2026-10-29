import { expect, test } from "vitest";
import { runCli } from "./cli.js";
import { VERSION } from "./version.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

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
