import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, expect, test } from "vitest";
import { VERSION } from "./version.js";

const dir = mkdtempSync(join(tmpdir(), "as-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function connect(args: string[]): Promise<Client> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist-test/cli.js", "mcp", "--data", join(dir, "data"), ...args],
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

test("the built bin files run: cli prints the version, mcp-bin starts and needs a principal", async () => {
  const run = (file: string, args: string[]) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 20_000 });
  const v = run("dist-test/cli.js", ["--version"]);
  expect(v.stdout.trim()).toBe(VERSION);
  const binVersion = run("dist-test/mcp-bin.js", ["--version"]);
  expect(binVersion.status).toBe(0);
  expect(binVersion.stdout.trim()).toBe(VERSION);
  expect(binVersion.stderr).not.toContain("unknown flag");
  const binShortVersion = run("dist-test/mcp-bin.js", ["-V"]);
  expect(binShortVersion.status).toBe(0);
  expect(binShortVersion.stdout.trim()).toBe(VERSION);
  const noPrincipal = run("dist-test/mcp-bin.js", ["--data", join(dir, "x")]);
  expect(noPrincipal.status).toBe(2);
  expect(noPrincipal.stderr).toContain("principal");
  const bad = run("dist-test/cli.js", ["erase", "u1", "--data", join(dir, "x"), "--as", "u2", "--kind", "human"]);
  expect(bad.status).toBe(3);
});
