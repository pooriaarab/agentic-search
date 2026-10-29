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
});
