# Changelog

## Unreleased

- Breaking: the default Worker export verifies `agentic-identity` credentials from the `DB` binding (`createStoreAuth`). Set `SEARCH_REGION`. Before, it refused every API call unless the dev flag was set. A missing token is 401 and a token without the route scope is 403. `SEARCH_UNSAFE_NO_AUTH=1` with `SEARCH_ENV` stays as the explicit local dev opt-in.
- `zod` is 4.6.7 (was 3.25.x) for GHSA-mrhx-c7xc-m3w5. The MCP tools advertise a new input schema: object schemas no longer set `additionalProperties: false`, and integer fields carry a min and max. Extra keys are still stripped at runtime. Invalid-argument error text now uses zod 4 wording. The status and the `isError` shape do not change.

## 0.4.0

- Breaking: the Worker verifies bearer tokens with `agentic-identity/http`. New option `createWorker({ auth, require })` answers 401 for a missing or bad token. It checks the scope per route (`search:read`, `search:write`, `search:admin`) and the kinds and origins in `require`, and answers 403 when a token falls short. A broken auth builder is a 500 with a logged `auth_error`. The principal comes from the token, and `x-principal-*` headers are ignored. `verifier` still works, but you must give exactly one of `auth` or `verifier`.
- Migration: the header-trust dev mode (`SEARCH_UNSAFE_NO_AUTH=1`) now also needs `SEARCH_ENV` to be exactly `development` or `test`. Without it, the Worker answers 401. Set `SEARCH_ENV` in trial setups, or move to bearer tokens.

## 0.3.1

- The MCP bin prints its version for `agentic-search-mcp --version` and `-V`, and exits 0. Before, the flag reached `mcp` and failed as an unknown flag. Only a first argument counts, as in the CLI.
- More principal edge tests: a `user_token` with `actingFor`, an `actingFor` at 256 characters, ids that start with `_` or `-`, and a non-principal error from the identity check that passes through unchanged. Tests only.

## 0.3.0

- Breaking: `parsePrincipal` checks the principal `id` with the `agentic-identity` rule. An id must start with an ASCII letter, digit, `_` or `-`, hold only ASCII letters, digits, `.`, `_` and `-`, and be at most 128 characters. Ids with `@`, `:`, spaces or non-ASCII letters (for example `zoë`), and longer ids, now throw `ValidationError`. The `actingFor` subject keeps the old rule (any non-empty string up to 256 characters).
- Breaking: `engines.node` is `>=22`. `agentic-identity` requires Node 22. CI tests Node 22 only.
- `PRINCIPAL_KINDS` and the principal kind check now come from `agentic-identity` (`^0.6.0`). That adds a runtime dependency, and through it `hono`. `agentic-search` no longer keeps its own copy. The exports and the `actingFor` rules do not change.

## 0.2.0

- Add `agentic-search/client`: a typed fetch client for every Worker route under `/api/v1`. `createClient({ baseUrl, token })` returns `health`, `search`, `index`, `remove`, `exportOwner`, and `eraseOwner`. A failed call throws `SearchApiError` with a `code` and the HTTP `status`. It uses only `fetch`.

- Breaking: `normalizeToken` is no longer exported from `agentic-search`. It was internal. Use `tokenize(text)`, whose tokens hold a `term`, or `queryTerms(query)`. `tokenize` also splits on non-word characters, so its terms can differ from `normalizeToken` output for input with punctuation or spaces.
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
