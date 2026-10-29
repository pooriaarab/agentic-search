#!/usr/bin/env node
import { runCli } from "./cli-core.js";
import { VERSION } from "./version.js";

// This bin only serves MCP. Its help names only the flags it reads, not the CLI commands.
const HELP = `agentic-search-mcp ${VERSION}
Serves the search tools over MCP on stdio. Set the principal with --as and --kind, or with
AGENTIC_SEARCH_AS, AGENTIC_SEARCH_KIND, and AGENTIC_SEARCH_ACTING_FOR. --data sets the local index.

Usage: agentic-search-mcp [mcp] [--as <id>] [--kind <kind>] [--acting-for <subject>] [--data <dir>]
       agentic-search-mcp [mcp] [--help | --version]`;

// The optional `mcp` word is skipped, as in `agentic-search-mcp mcp --version`. Help and version answer anywhere
// in the arguments, so `agentic-search-mcp --as u1 --help` shows this bin's help and does not start the server.
const args = process.argv.slice(2);
const rest = args[0] === "mcp" ? args.slice(1) : args;

async function main(): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  // The version flags belong to the CLI, so route them there. Every other argument goes to the `mcp` command.
  return runCli(rest.includes("--version") || rest.includes("-V") ? ["--version"] : ["mcp", ...rest]);
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
