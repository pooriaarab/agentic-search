import { readFile } from "node:fs/promises";
import { PRINCIPAL_KINDS } from "agentic-identity";
import { ForbiddenError, ValidationError } from "./core/errors.js";
import type { ItemKind, Principal, SearchRequest } from "./core/types.js";
import { parsePrincipal } from "./core/validate.js";
import { openLocal } from "./local.js";
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
  "  search <query>   Search what the principal may read.",
  "  index <file|->   Index items from a JSON file or stdin (one item or a list).",
  "  remove <id>      Remove one item.",
  "  export <owner>   Print everything one owner has indexed.",
  "  erase <owner>    Erase everything one owner has indexed.",
  "  mcp              Start the MCP server on stdio.",
  "",
  "Principal (required, no default kind):",
  "  --as <id>, --kind <kind>, --acting-for <subject>",
  "  or AGENTIC_SEARCH_AS, AGENTIC_SEARCH_KIND, AGENTIC_SEARCH_ACTING_FOR",
  `  kinds: ${PRINCIPAL_KINDS.join(", ")}`,
  "",
  "Search flags:",
  "  --item-kind <k> (repeatable), --owner, --resource-type, --resource-id,",
  "  --after <ms>, --before <ms>, --limit <n>, --cursor <c>, --json",
  "",
  "Other flags:",
  "  --data <dir>     Where the local index lives (AGENTIC_SEARCH_DATA, default ./.agentic-search).",
  "  --help, -h       Print this help.",
  "  --version, -V    Print the version.",
  "",
  "The local index is one JSON file for one writer. Use the HTTP API for shared data.",
].join("\n");

const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const VALUE_FLAGS = new Set([
  "as", "kind", "acting-for", "data", "item-kind", "owner", "resource-type", "resource-id",
  "after", "before", "limit", "cursor",
]);

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
  json: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      out.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (name === "help") {
      out.help = true;
    } else if (name === "json") {
      out.json = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new ValidationError(`--${name} needs a value`);
      out.flags.set(name, [...(out.flags.get(name) ?? []), value]);
    } else {
      throw new ValidationError(`unknown flag --${name}`);
    }
  }
  return out;
}

function one(p: Parsed, name: string, env?: string): string | undefined {
  return p.flags.get(name)?.at(-1) ?? (env === undefined ? undefined : process.env[env]);
}

function num(p: Parsed, name: string): number | undefined {
  const v = one(p, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new ValidationError(`--${name} must be a whole number`);
  return Number(v);
}

function principalOf(p: Parsed): Principal {
  const id = one(p, "as", "AGENTIC_SEARCH_AS");
  const kind = one(p, "kind", "AGENTIC_SEARCH_KIND");
  if (id === undefined || kind === undefined) {
    const missing = [
      ...(id === undefined ? ["--as or AGENTIC_SEARCH_AS"] : []),
      ...(kind === undefined ? ["--kind or AGENTIC_SEARCH_KIND"] : []),
    ];
    throw new ValidationError(`a principal is required. Missing: ${missing.join(", ")}`);
  }
  const actingFor = one(p, "acting-for", "AGENTIC_SEARCH_ACTING_FOR");
  return parsePrincipal({ id, kind, ...(actingFor === undefined ? {} : { actingFor }) });
}

/** One argument after the command. `search` joins every word into one query. */
function need(p: Parsed, what: string): string {
  const rest = p.positional.slice(1);
  if (rest.length === 0) throw new ValidationError(`${what} is required`);
  if (rest.length > 1 && what !== "query") throw new ValidationError(`give one ${what}`);
  return rest.join(" ");
}

async function readInput(path: string): Promise<unknown> {
  const raw = path === "-" ? await new Response(process.stdin as never).text() : await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("input is not valid JSON");
  }
}

async function command(first: string, p: Parsed, io: CliIo): Promise<number> {
  const principal = principalOf(p);
  const dir = one(p, "data", "AGENTIC_SEARCH_DATA") ?? ".agentic-search";
  if (first === "mcp") {
    const { startMcp } = await import("./mcp.js");
    await startMcp(await openLocal(dir), principal);
    return 0;
  }
  const svc = await openLocal(dir);
  const print = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  switch (first) {
    case "search": {
      const resourceType = one(p, "resource-type");
      if (resourceType === undefined && one(p, "resource-id") !== undefined) {
        throw new ValidationError("--resource-id needs --resource-type");
      }
      const request: SearchRequest = {
        query: need(p, "query"),
        kinds: p.flags.get("item-kind") as ItemKind[] | undefined,
        owner: one(p, "owner"),
        resource: resourceType === undefined ? undefined : { type: resourceType, id: one(p, "resource-id") },
        updatedAfter: num(p, "after"),
        updatedBefore: num(p, "before"),
        limit: num(p, "limit"),
        cursor: one(p, "cursor"),
      };
      for (const k of Object.keys(request) as (keyof SearchRequest)[]) if (request[k] === undefined) delete request[k];
      const page = await svc.search(principal, request);
      if (p.json) print(page);
      else {
        for (const h of page.hits) io.out(`${h.kind}\t${h.id}\t${h.title}\n  ${h.snippet.text}`);
        if (page.nextCursor !== undefined) io.out(`next: ${page.nextCursor}`);
      }
      return 0;
    }
    case "index":
      print(await svc.index(principal, await readInput(need(p, "file"))));
      return 0;
    case "remove":
      print(await svc.remove(principal, need(p, "id")));
      return 0;
    case "export":
      print(await svc.exportOwner(principal, need(p, "owner")));
      return 0;
    case "erase":
      print(await svc.eraseOwner(principal, need(p, "owner")));
      return 0;
  }
  throw new ValidationError(`unknown command "${first}"`);
}

const COMMANDS = new Set(["search", "index", "remove", "export", "erase", "mcp"]);

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
  if (first === "mcp" && (argv[1] === "--version" || argv[1] === "-V")) {
    io.out(VERSION);
    return 0;
  }
  if (!COMMANDS.has(first)) {
    io.err(`unknown command "${first}"`);
    io.err('Run "agentic-search --help" for usage.');
    return 2;
  }
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      io.out(HELP);
      return 0;
    }
    return await command(first, parsed, io);
  } catch (error) {
    if (error instanceof ValidationError) io.err(error.message);
    else if (error instanceof ForbiddenError) io.err("not allowed");
    else io.err(`failed (${error instanceof Error ? error.name : "unknown"})`);
    return error instanceof ValidationError ? 2 : error instanceof ForbiddenError ? 3 : 1;
  }
}

