# Changelog

## 0.8.2 - 2026-10-30

**Changed**

- Accept shared package releases below 1.0.0 and test the current releases.

## 0.8.1 - 2026-10-30

**Changed**

- Accept agentic-design 0.10.x and agentic-identity 0.11.x. Test current and minimum shared package releases.

## 0.8.0 - 2026-10-30

**Added**

- Add table, task, form and board kinds to indexing, filters and result groups.
- Verify all suite kinds with human and agent callers on memory, file and D1 stores.
- Verify that revoked shares deny fresh searches and saved cursor pages in lexical and hybrid search.
- Add demo samples for the new kinds. Set `SEARCH_E2E_PORT` to change the browser test port.

## 0.7.1 - 2026-10-30

**Changed**

- Allow current releases of the shared packages.

## 0.7.0

- Add `agentic-search/account` with a typed account registry contributor.
- Export owner index copies and vectors; erase both with safe retries.
- Refuse damaged account rows and invalid ownership or repeated ids.
- Document shared-source and authorship boundaries for host account workflows.

## 0.6.3

Patch. No change to the SDK, CLI, MCP or HTTP shape.

- `agentic-design` (dependency) moves from `^0.6.0` to `^0.8.0`. The range now accepts the newest `agentic-design` on npm, so all `agentic-*` packages install together without an ERESOLVE error.
- Versions 0.7.0 and 0.8.0 do not change the components this package uses (`Button`, `EmptyState`, `AlertIcon`, `CloseIcon`, `FileIcon`, and the `agd-` classes). No source change is needed. Build, typecheck, unit tests, and browser tests (axe, light and dark, 390px) pass with `agentic-design` 0.8.0.
- The lockfile follows the bump.

## 0.6.2

Patch. No change to the SDK, CLI, MCP or HTTP shape.

- `agentic-identity` (dependency) moves from `^0.8.0` to `^0.9.0`.
- `agentic-design` (dependency) moves from `^0.5.0` to `^0.6.0`. Version 0.6.0 changes the `Tabs` focus order to a roving tab index. This package's `SearchBox` does not use `Tabs`, so the change does not reach it.
- The lockfile follows both bumps and now lists the optional `react` and `react-dom` peers that `package.json` already declares. Build, typecheck, unit tests, and browser tests pass with `agentic-identity` 0.9.0 and `agentic-design` 0.6.0.

## 0.6.1

Patch. No change to the SDK, the HTTP API, or the MCP tools. One exit code changes: see the stray-word bullet.

- `agentic-search-mcp mcp --version` prints the version and exits 0. Before, the `mcp` word made the flag an unknown flag, and the command exited 2.
- `agentic-search-mcp --help` and `agentic-search-mcp mcp --help` print the bin's own usage, under `agentic-search-mcp`. It lists only the flags the bin reads. Before, they printed the CLI usage under `agentic-search`.
- A stray word after `mcp` exits 2 with a usage error, on both bins: `agentic-search-mcp extra` and `agentic-search mcp extra`. Before, the word was ignored and the server started. An MCP client config that passes an extra word must drop it.

## 0.6.0

Minor. New `agentic-search/ui` export. No change to the SDK, CLI, MCP or HTTP shape.

- Add `agentic-search/ui`: a React `SearchBox` with a `/` and Ctrl+K shortcut, debounced queries, results grouped by kind, keyboard navigation, and empty and error states (#56). Import `agentic-search/ui.css` for its styles.
- `agentic-design` (`^0.5.0`) is a dependency. `react` and `react-dom` are optional peers.
- The demo Worker serves the search box and a read-only search API over sample items. Before, every call except health answered 500.
- Add browser tests with axe (WCAG 2.2 AA, light and dark, 390px wide). `ci:local` runs them.

## 0.5.1

Patch. No change to the SDK, CLI, MCP or HTTP shape.

- `agentic-identity` is `^0.8.0`. The lockfile follows. The 0.8.0 additions (`tokens create`, `delegations create`) are not used here.

## 0.5.0

Minor. Breaking for the default Worker export; see the first item.

- Breaking: the default Worker export verifies `agentic-identity` credentials from the `DB` binding (`createStoreAuth`) (#45). Set `SEARCH_REGION`. Before, it refused every API call unless the dev flag was set. A missing token is 401 and a token without the route scope is 403. `SEARCH_UNSAFE_NO_AUTH=1` with `SEARCH_ENV` stays as the explicit local dev opt-in.
- The zod dependency is `^4.6.7` (#47, #49). Earlier versions can use a lot of memory on oversized constrained collections (GHSA-mrhx-c7xc-m3w5).
- The MCP tools advertise a new input schema, from zod 4 (#49). Object schemas no longer set `additionalProperties: false`, and integer fields carry a min and max. Extra keys are still stripped at runtime. Invalid-argument error text now uses zod 4 wording. The status and the `isError` shape do not change.
- The MCP SDK floor is `^1.23.0` (#49), the first release that accepts zod 4 schemas.
- `agentic-identity` is `^0.7.0` (#40). The lockfile follows.
- `agentic-search mcp --version` prints the version and exits 0, like `--help` (#41). Before, the flag failed as an unknown flag and exited 2.
- A missing principal names the missing flags and the `AGENTIC_SEARCH_AS` and `AGENTIC_SEARCH_KIND` variables (#41). The exit code is still non-zero.
- The publish workflow runs one publish at a time per ref (#43). A second run waits for the first. A running publish finishes.

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
