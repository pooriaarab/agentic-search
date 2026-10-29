# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-10-29

First release.

### Added

- Core search library: `createSearch`, an in-memory index (`MemoryIndex`) and
  an injectable `AccessPolicy`. Access is checked before any hit, snippet or
  cursor is returned.
- Items with the kinds `document`, `sheet`, `slide`, `file` and `comment`.
- Query with ANDed words, a prefix match on the last word, BM25 ranking and
  title boost, snippets with highlight offsets, and filters for kind, owner,
  resource and time range.
- Sealed pagination cursors (AES-GCM, key from `cursorSecret`).
- Erase and export by owner (`eraseOwner`, `exportOwner`) and removal by item
  (`remove`).
- D1 storage adapter: `agentic-search/d1` (`D1Index`, `D1Index.migrate`).
- Contract suite for store adapters: `agentic-search/testing`
  (`runIndexContract`).
- HTTP API as a Cloudflare Worker under `/api/v1`: search, item index and
  remove, owner export and erase, and health.
- CLI: `agentic-search` (`npx agentic-search --help`).
- MCP server: `agentic-search mcp` over stdio, also `agentic-search-mcp`.

### Known limits

- The default Worker has no real authentication. It refuses `/api/v1` calls
  unless `SEARCH_UNSAFE_NO_AUTH=1` is set. Use `createWorker({ verifier })`
  with your own `AuthVerifier` for real use.
- The memory index scans every item on each query. Use it for tests and small
  sets.
- A search scans at most 1000 store hits. Hidden items can make a page short
  or empty while `nextCursor` is still set.
