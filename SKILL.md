---
name: agentic-search
description: Search documents, sheets, slides, files and comments with access filtering. Index, remove, search and reindex items.
---

# agentic-search

Search for people and agents. Results hold only items the caller may read.

## Use the MCP server

Start it with `npx agentic-search mcp --as <id> --kind <kind>`. Tools: `search`, `index`, `remove`, `export_owner`, `erase_owner`. A failed call returns an error result. A search page has a `nextCursor` while more results exist: pass it back to continue, and keep paging until it is absent.

## Rules

- Read the rules at https://github.com/pooriaarab/agentic-search/blob/main/RULES.md before you index or search.
- Report errors as errors.
