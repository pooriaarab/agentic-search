# Changelog

## Unreleased

- Breaking: `normalizeToken` is no longer exported from `agentic-search`. It was internal. Use `tokenize(text)`, whose tokens hold a `term`, or `queryTerms(query)`.
- Document every SDK export in the README and llms.txt.

## 0.1.0

First release.

- Search core: items, filters, BM25-shaped ranking with no corpus statistics, snippets cut on grapheme boundaries, sealed cursors, access filter before every result.
- Stores: memory index, D1 adapter (`agentic-search/d1`), local JSON index for the CLI and MCP. One contract suite (`agentic-search/testing`) runs against each.
- HTTP API: a Worker under `/api/v1` with an injected `AuthVerifier` (`agentic-search/worker`).
- CLI: `search`, `index`, `remove`, `export`, `erase`, `mcp`.
- MCP server on stdio with the same calls.
- Vector port (`Embedder`, `VectorStore`), a memory reference store, and hybrid ranking with a ranker hook. No vendor SDK.
- Erase by item and by owner removes vectors too.
