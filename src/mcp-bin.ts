#!/usr/bin/env node
import { runCli } from "./cli-core.js";

runCli(["mcp", ...process.argv.slice(2)]).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
