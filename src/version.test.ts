import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  test("matches package.json without a build", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  test("the README status line names the same version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`**Status:** version ${pkg.version}.`);
  });
});
