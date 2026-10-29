import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ForbiddenError, ValidationError } from "./core/errors.js";
import type { SearchService } from "./core/service.js";
import { ITEM_KINDS, type Principal } from "./core/types.js";
import { VERSION } from "./version.js";

const kind = z.enum(ITEM_KINDS);
const item = z.object({
  id: z.string(),
  kind,
  title: z.string(),
  text: z.string(),
  owner: z.string(),
  resource: z.object({ type: z.string(), id: z.string() }),
  updatedAt: z.number().int(),
});

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Run one call. A failure is an error result, never a silent success. Unknown errors show no detail. */
async function respond(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run()) }] };
  } catch (error) {
    const text =
      error instanceof ValidationError ? error.message : error instanceof ForbiddenError ? "not allowed" : "internal error";
    return { isError: true, content: [{ type: "text", text }] };
  }
}

/** Tools over the search core. Every call runs as the one principal given here. */
export function createMcpServer(service: SearchService, principal: Principal): McpServer {
  const server = new McpServer({ name: "agentic-search", version: VERSION });
  server.registerTool(
    "search",
    {
      description: "Search indexed items the caller may read. Returns a page. Pass nextCursor back to continue.",
      inputSchema: {
        query: z.string(),
        kinds: z.array(kind).optional(),
        owner: z.string().optional(),
        resource: z.object({ type: z.string(), id: z.string().optional() }).optional(),
        updatedAfter: z.number().int().optional(),
        updatedBefore: z.number().int().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
      },
    },
    (args) => respond(() => service.search(principal, args)),
  );
  server.registerTool(
    "index",
    { description: "Add or replace items in the index.", inputSchema: { items: z.array(item) } },
    ({ items }) => respond(() => service.index(principal, items)),
  );
  server.registerTool(
    "remove",
    { description: "Remove one item by id.", inputSchema: { id: z.string() } },
    ({ id }) => respond(() => service.remove(principal, id)),
  );
  server.registerTool(
    "export_owner",
    { description: "Export everything one owner has indexed.", inputSchema: { owner: z.string() } },
    ({ owner }) => respond(() => service.exportOwner(principal, owner)),
  );
  server.registerTool(
    "erase_owner",
    { description: "Erase everything one owner has indexed.", inputSchema: { owner: z.string() } },
    ({ owner }) => respond(() => service.eraseOwner(principal, owner)),
  );
  return server;
}

export async function startMcp(service: SearchService, principal: Principal): Promise<void> {
  await createMcpServer(service, principal).connect(new StdioServerTransport());
}
