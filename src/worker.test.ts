import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import worker from "./worker.js";
import { VERSION } from "./version.js";

describe("worker", () => {
  test("GET /health reports name and version", async () => {
    const res = await worker.fetch(new Request("http://x/health"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "agentic-search", version: VERSION });
  });

  test("unknown path is 404", async () => {
    const res = await worker.fetch(new Request("http://x/nope"), {});
    expect(res.status).toBe(404);
  });

  test("GET /api/v1/health works", async () => {
    const res = await worker.fetch(new Request("http://x/api/v1/health"), {});
    expect(res.status).toBe(200);
  });

  test("bundles for a Worker runtime without Node built-ins", async () => {
    const result = await build({
      entryPoints: ["src/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
  });
});
