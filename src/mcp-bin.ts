#!/usr/bin/env node
import { runCli } from "./cli-core.js";

// The version flags belong to the CLI, not to `mcp`, so route them there.
const args = process.argv.slice(2);
const version = args.includes("--version") || args.includes("-V");

runCli(version ? ["--version"] : ["mcp", ...args]).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
