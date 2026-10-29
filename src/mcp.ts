import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "./version.js";

export function createMcpServer(): McpServer {
  return new McpServer({ name: "agentic-search", version: VERSION });
}

export async function startMcp(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
