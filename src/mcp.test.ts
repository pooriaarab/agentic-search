import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, test } from "vitest";
import { VERSION } from "./version.js";

let dir: string;
let entry: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "as-mcp-"));
  entry = join(dir, "cli.mjs");
  await build({
    entryPoints: ["src/cli.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: "silent",
  });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function connect(args: string[]): Promise<Client> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp", "--data", join(dir, "data"), ...args],
      stderr: "pipe",
    }),
  );
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;
const doc = (id: string, owner: string, body: string) => ({
  id, kind: "document", title: `T ${id}`, text: body, owner, resource: { type: "doc", id }, updatedAt: 5,
});

test("the real MCP server over stdio indexes, searches, exports and erases", async () => {
  const client = await connect(["--as", "u1", "--kind", "human"]);
  try {
    expect(client.getServerVersion()).toMatchObject({ name: "agentic-search", version: VERSION });
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["erase_owner", "export_owner", "index", "remove", "search"]);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    expect(JSON.parse(text(await call("index", { items: [doc("a", "u1", "alpha budget"), doc("c", "u1", "gamma budget")] })))).toEqual({ indexed: 2 });
    // Writing for another owner is an error result, not a silent success.
    const denied = await call("index", { items: [doc("b", "u2", "beta budget")] });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toBe("not allowed");

    const found = JSON.parse(text(await call("search", { query: "budget" })));
    expect(found.hits.map((h: { id: string }) => h.id).sort()).toEqual(["a", "c"]);
    const bad = await call("search", { query: "!!!" });
    expect(bad.isError).toBe(true);

    expect(JSON.parse(text(await call("remove", { id: "c" })))).toEqual({ removed: true });
    expect(JSON.parse(text(await call("export_owner", { owner: "u1" }))).items.map((i: { id: string }) => i.id)).toEqual(["a"]);
    expect((await call("export_owner", { owner: "u2" })).isError).toBe(true);
    expect(JSON.parse(text(await call("erase_owner", { owner: "u1" })))).toEqual({ removed: 1 });
    expect(JSON.parse(text(await call("search", { query: "budget" }))).hits).toEqual([]);
  } finally {
    await client.close();
  }
});

test("the server refuses to start without a principal kind", async () => {
  await expect(connect(["--as", "u1"])).rejects.toThrow();
});
