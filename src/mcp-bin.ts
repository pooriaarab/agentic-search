#!/usr/bin/env node
import { runCli } from "./cli-core.js";

// The optional `mcp` word is skipped, as in `agentic-search-mcp mcp --version`. Help and version answer here,
// under the bin's own name. Every other argument goes to the `mcp` command. Only a first argument counts.
const args = process.argv.slice(2);
const rest = args[0] === "mcp" ? args.slice(1) : args;
const answer = ["--help", "-h", "--version", "-V"].includes(rest[0] ?? "");

runCli(answer ? rest : ["mcp", ...rest], undefined, "agentic-search-mcp").then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
