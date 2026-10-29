#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCli } from "./cli-core.js";

export { runCli };
export type { CliIo } from "./cli-core.js";

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // On zero, fall off the end so a running MCP server keeps its stdio open.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
