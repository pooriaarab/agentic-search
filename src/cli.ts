#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION } from "./version.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const HELP = [
  `agentic-search ${VERSION}`,
  "Search for documents, sheets, slides, files and comments.",
  "",
  "Usage: agentic-search <command> [flags]",
  "",
  "Commands:",
  "  mcp   Start the MCP server on stdio.",
  "",
  "Flags:",
  "  --help, -h       Print this help.",
  "  --version, -V    Print the version.",
].join("\n");

const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP);
    return 0;
  }
  if (first === "--version" || first === "-V") {
    io.out(VERSION);
    return 0;
  }
  if (first === "mcp") {
    const { startMcp } = await import("./mcp.js");
    await startMcp();
    return 0;
  }
  io.err(`unknown command "${first}"`);
  io.err('Run "agentic-search --help" for usage.');
  return 2;
}

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
