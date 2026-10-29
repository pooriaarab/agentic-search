import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import { createMcpServer } from "./mcp.js";
import { VERSION } from "./version.js";

test("server identifies itself", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([createMcpServer().connect(a), client.connect(b)]);
  expect(client.getServerVersion()).toMatchObject({ name: "agentic-search", version: VERSION });
});
