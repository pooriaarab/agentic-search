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
- Query with ANDed words and a prefix match on the last word. Ranking is
  BM25-shaped with no corpus statistics, plus a title boost. Snippets carry
  highlight offsets. Filters cover kind, owner, resource and time range.
- Vector ports: `Embedder` (a model you host, no vendor SDK in the package)
  and `VectorStore`. `MemoryVectorStore` is the in-memory store.
- Hybrid search: pass `vectors: { embedder, store }` to `createSearch`. Word
  hits and vector hits are both filtered by access before they are fused with
  reciprocal rank fusion (`reciprocalRankFusion`). Set `mode: "lexical"` or
  `mode: "hybrid"` on a request. Hybrid is the default when vectors are set.
- Sealed pagination cursors (AES-GCM, key from `cursorSecret`).
- Erase and export by owner (`eraseOwner`, `exportOwner`) and removal by item
  (`remove`).
- D1 storage adapter: `agentic-search/d1` (`D1Index`, `D1Index.migrate`).
- Contract suites for store adapters: `agentic-search/testing` exports
  `runIndexContract` and `runVectorContract`.
- HTTP API as a Cloudflare Worker under `/api/v1`: search, item index and
  remove, owner export and erase, and health. Build your own Worker with
  `createWorker` from `agentic-search/worker`.
- CLI: `agentic-search` (`npx agentic-search --help`).
- MCP server: `agentic-search mcp` over stdio, also `agentic-search-mcp`.

### Known limits

- The default Worker has no real authentication. It refuses every `/api/v1`
  call except health unless `SEARCH_UNSAFE_NO_AUTH=1` is set. For real use, call
  `createWorker({ verifier })` from `agentic-search/worker` with your own
  `AuthVerifier`.
- The memory index scans every item on each query. Use it for tests and small
  sets.
- There is no D1 vector store yet. Hybrid search on D1 needs your own
  `VectorStore`, which must pass `runVectorContract`. Erase must remove the
  vectors as well as the words.
- In lexical mode, a search scans at most 1000 store hits. Hidden items can make a page short
  or empty while `nextCursor` is still set.
- Hybrid search returns at most `2 × depth` results per query (default `depth` is 100 per side). A cursor past that limit is rejected.
