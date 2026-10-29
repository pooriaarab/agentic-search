# agentic-search agent guide

Search for documents, sheets, slides, files and comments, filtered by
what the caller may read.

## Mental model

Apps index items. Callers search. The access filter runs before any
result, snippet or count leaves the package. A caller sees only what
the filter allows.

## The faces

- SDK: `import { ... } from "agentic-search"`.
- CLI: `npx agentic-search ...`.
- MCP: `npx agentic-search mcp`.
- HTTP API: a Worker under `/api/v1`.

Status: scaffold only. The core lands in the next pull requests.

## Rules

- Never return an item the access filter denied.
- Never log titles, text or owner identifiers.
- Report failures as failures. No silent success after an error.
- Erase by owner and by item must remove every copy, vectors too.
