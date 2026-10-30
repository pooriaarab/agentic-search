# agentic-search

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Source](https://github.com/pooriaarab/agentic-search) · [Support](https://github.com/pooriaarab/agentic-search/issues)

Search and indexing for documents, sheets, slides, tables, tasks, forms, boards, files and comments, for people and agents. Ports and adapters, Cloudflare first.

**Status:** version 0.8.0. The library, the D1 adapter, the Worker API, the HTTP client, the React search box, the CLI, the MCP server and the vector port work. See Limits before you rely on it.

## Install

```sh
npm install agentic-search
```

Requires Node.js 22 or later.

## Quick start

```ts
import { createSearch, MemoryIndex } from "agentic-search";

const search = await createSearch({
  store: new MemoryIndex(),
  cursorSecret: process.env.SEARCH_CURSOR_SECRET!, // at least 32 bytes, kept secret
});
const me = { id: "u1", kind: "human" } as const;

await search.index(me, [
  {
    id: "doc-1",
    kind: "document",
    title: "Budget 2026",
    text: "The annual budget is final.",
    owner: "u1",
    resource: { type: "doc", id: "doc-1" },
    updatedAt: Date.now(),
  },
]);

const page = await search.search(me, { query: "budget", kinds: ["document"], limit: 10 });
// page.hits[0].snippet = { text: "The annual budget is final.", highlights: [[11, 17]] }
// page.nextCursor is set when more results exist.
```

### CLI and MCP

```sh
export AGENTIC_SEARCH_AS=u1 AGENTIC_SEARCH_KIND=human
npx agentic-search index items.json
npx agentic-search search budget --json
npx agentic-search mcp
```

The principal is required, and there is no default kind. The CLI and MCP keep a local JSON index in `./.agentic-search` (set `--data` or `AGENTIC_SEARCH_DATA`). It is for one machine and small data. Use the HTTP API with D1 for shared data. The MCP tools are `search`, `index`, `remove`, `export_owner` and `erase_owner`.

## How it works

- **Shares.** Apps supply an `AccessPolicy` that checks current read rights for each principal. Search checks it on every call, including cursor pages. A revoked share stops access without reindexing. The default policy allows only the owner subject. Docs use the `document` kind.
- **Items.** An item has `id`, `kind` (`document`, `sheet`, `slide`, `table`, `task`, `form`, `board`, `file`, `comment`), `title`, `text`, `owner`, a `resource` reference and `updatedAt`.
- **Query.** Words are ANDed. The last word also matches as a prefix. Case and accents do not matter. Filters: kinds, owner, resource, time range.
- **Ranking.** Saturated term frequency with length normalisation (the BM25 shape). Title words count three times. No corpus statistics.
- **Snippets.** A text window with highlight offsets. No HTML is produced.
- **Pagination.** A sealed cursor (AES-GCM, key from `cursorSecret`). Callers cannot read it. It works only for the query and caller that made it. A missing or short secret throws.
- **Access.** Inject an `AccessPolicy`. The default lets a principal read only what its subject owns. The service checks the policy before it returns any hit, snippet or cursor. Only an answer of exactly `true` allows. A malformed answer throws.
- **No counts.** A page has no total, because a total would leak hidden items.
- **Principals.** Every call takes a principal with a required `kind`. Agent principals act for a subject. The kind list and the id rule come from `agentic-identity`. A principal id holds ASCII letters (A–Z, a–z), digits, `.`, `_` and `-`, up to 128 characters, and does not start with `.`. An `actingFor` subject uses the older rule: any non-empty string up to 256 characters.
- **Privacy.** `eraseOwner` and `remove` delete data. `exportOwner` returns everything indexed for one owner. Logs hold counts only.
- **D1.** `import { D1Index } from "agentic-search/d1"`. Run `D1Index.migrate(env.DB)` once, then pass `new D1Index(env.DB)` as `store`. Create the database with an EU location hint if you need EU residency.
- **Hybrid search.** Pass `vectors: { embedder, store }` to `createSearch`. You supply an `Embedder` (a model you host) and a `VectorStore`. `MemoryVectorStore` is the reference. Word hits and vector hits are cut to what the caller may read, then fused (reciprocal rank fusion, or your own `rank` hook). Erase removes vectors too. A failing embedder fails the call.
- **Testing your own store.** `agentic-search/testing` exports `runIndexContract` and `runVectorContract` for adapters. It also exports `item`, a fixture builder, and the `ContractHarness` type.

## SDK exports

`import { ... } from "agentic-search"` exports these names.

| Name | What it is |
|---|---|
| `VERSION` | The package version. |
| `createSearch(opts)` | Make the search service. Pass a `store` and a `cursorSecret`. Optional: `access`, `logger`, `maxScan`, `now` and `vectors`. |
| `noopLogger` | The default logger. It drops every event. |
| `MemoryIndex` | The in-memory store. It is for tests and small sets. |
| `MemoryVectorStore` | The in-memory vector store. It is the reference for `VectorStore`. |
| `reciprocalRankFusion(k?)` | The default hybrid ranker. Pass your own as the `rank` hook. |
| `ownerPolicy` | The default access policy. A principal reads, writes and manages only what its subject owns. |
| `subjectOf(principal)` | The subject a principal acts for. Use it when you write an `AccessPolicy`. |
| `parseItem(input)`, `parsePrincipal(input)` | Check input and return a typed item or principal. They throw `ValidationError`. |
| `LIMITS` | The size limits that the checks use. |
| `ValidationError` | Thrown for bad input. |
| `ForbiddenError` | Thrown when the access policy denies an index or reindex write, or an erase or export for an owner. `remove` returns `removed: false` instead. |
| `ITEM_KINDS`, `PRINCIPAL_KINDS` | The allowed item kinds and principal kinds. |
| `tokenize(text)`, `queryTerms(query)` | `tokenize` returns each term with its start and end offsets. `queryTerms` returns the unique terms of a query. |

The package also exports types for each shape, such as `IndexedItem`, `Principal`, `SearchRequest`, `SearchPage`, `AccessPolicy`, `IndexStore`, `Embedder` and `VectorStore`.

Subpath exports:

- `agentic-search/d1`: `D1Index` and `D1_SCHEMA`. Types: `D1Like`, `D1StatementLike` and `D1ResultLike`.
- `agentic-search/worker`: `createWorker`, the Worker factory. Pass `auth` to verify bearer tokens with `agentic-identity`. The default export verifies `agentic-identity` credentials from the `DB` binding. It needs `SEARCH_REGION` (`eu` or `us`; `unknown` only for local trials). Types: `AuthVerifier`, `AuthSource`, `WorkerEnv` and `WorkerOptions`.
- `agentic-search/testing`: `runIndexContract`, `runVectorContract`, `item` and the `ContractHarness` type (see How it works).

## HTTP API

**Authentication.** Call `createWorker({ auth })` with an `Auth` from `agentic-identity` (or a function that builds one from `env`). The Worker checks the `Authorization: Bearer` token with `agentic-identity/http`. A missing, bad, expired or revoked token answers 401. The Worker needs the scope `search:read` for search and export, `search:write` for index and remove, and `search:admin` for erase by owner. A token without it answers 403 (`*:read` covers read only). Use `require: { kinds }` to refuse some kinds of token with 403. The principal comes from the verified token. For an agent, `actingFor` is the root of its chain. The Worker ignores every `x-principal-*` header in this mode. Give `auth` or `verifier`, not both.

**Default Worker export.** It reads credentials and principals from the identity tables in the `DB` binding (`agentic-identity` `createStoreAuth`). Set `SEARCH_REGION` to `eu` or `us`. A missing token answers 401. A token without the route scope answers 403. A missing `DB` or `SEARCH_REGION` answers 500, so it fails closed.

**Warning:** `SEARCH_UNSAFE_NO_AUTH=1` switches the default export to a dev mode with no authentication. It trusts the headers `x-principal-id`, `x-principal-kind` and `x-principal-acting-for`. Use it for local trials only. It also needs `SEARCH_ENV` set to exactly `development` or `test`. Unset, `production` or any other value refuses, so a production deploy fails closed. You can also pass your own `verifier` to `createWorker`: it returns the principal, or `null` for no access. A throw also means no access.

Bindings: `DB` (D1, run `migrations/0001_init.sql`), `SEARCH_CURSOR_SECRET` (32 bytes or more).

| Call | Does |
|---|---|
| `GET /api/v1/health` | Name and version. No auth. |
| `POST /api/v1/search` | Body: a search request. Returns a page. |
| `POST /api/v1/items` | Body: one item or `{ "items": [...] }`. |
| `DELETE /api/v1/items/:id` | Remove one item. |
| `GET /api/v1/owners/:owner/export` | Export everything one owner has indexed. |
| `DELETE /api/v1/owners/:owner` | Erase everything one owner has indexed. |

Errors: 400 bad input, 401 no principal, 403 not allowed, 413 and 415 bad body, 500 internal (no details).

## HTTP client

`agentic-search/client` is a typed client for the Worker routes. It uses only `fetch`, so it runs in browsers, Workers, and Node 22. It sends `Authorization: Bearer <token>`. Your `AuthVerifier` reads that header and decides who the caller is.

```ts
import { createClient, SearchApiError } from "agentic-search/client";

const search = createClient({ baseUrl: "https://search.example.com", token });
await search.index({ id: "a", kind: "document", title: "Plan", text: "quarterly budget plan", owner: "ann", resource: { type: "doc", id: "a" }, updatedAt: Date.now() });
const page = await search.search({ query: "budget", limit: 10 });
try {
  await search.exportOwner("someone-else");
} catch (error) {
  if (error instanceof SearchApiError) console.error(error.code, error.status);
}
```

- The methods are `health`, `search`, `index`, `remove`, `exportOwner`, and `eraseOwner`. Each takes an optional `{ signal }`.
- `baseUrl` is the Worker URL, `http` or `https`, with no query, hash, or credentials. `token` is visible ASCII with no spaces or line breaks.
- A failed call throws `SearchApiError`. The Worker sends only an error text, so `code` comes from the status: `INVALID_INPUT` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `INTERNAL` (500). Any other status, and a `200` reply with the wrong shape, is `UNKNOWN`.
- The client never follows a redirect and never retries. A network failure rejects with the error from `fetch`, not a `SearchApiError`, and so does an aborted call.

## Search box (React)

`agentic-search/ui` is a React search box. It takes a client from `agentic-search/client`, so it searches through the HTTP API and sees only what the caller may read. React 18 or later is an optional peer. The box uses the `agd-` classes of `agentic-design`, which is a dependency.

```tsx
import "agentic-design/styles.css";
import "agentic-search/ui.css";
import { createClient } from "agentic-search/client";
import { SearchBox } from "agentic-search/ui";

const client = createClient({ baseUrl: "https://search.example.com", token });

<SearchBox client={client} onSelect={(hit) => open(hit.resource)} />;
```

- Create the client once, outside render or with `useMemo`. A new client makes the box search again.
- Press `/` or Ctrl+K (Cmd+K on a Mac) to focus the field. Ctrl+K works from any field, so it takes the key from an editor on the same page. A `/` typed in a text field stays text. Set `shortcut={false}` to turn the keys off.
- A query goes out `debounceMs` (200) after the last key. A newer query cancels the one in flight, so an old answer never replaces a new one.
- Results show in groups: documents, sheets, slides, tables, tasks, forms, boards, files, comments. The field keeps focus. Arrow Down and Arrow Up move through the results, Enter picks one, and Escape closes the panel and then clears the field.
- A failed call shows an error with a Try again button. It never shows as "no results". No match shows an empty state.
- It follows the combobox pattern, announces the result count, and works at 390px wide. Tests check it with axe against WCAG 2.2 AA in light and dark.
- `labels` replaces any text, for other languages. `kinds` limits the search. `limit` sets the page size (default 20).
- Any object with a `search(request, { signal })` method works as `client`.

Screenshots are in `docs/screenshots`.

## Live demo

A demo Worker runs at <https://agentic-search-demo.hello-fd1.workers.dev>.

```sh
curl https://agentic-search-demo.hello-fd1.workers.dev/api/v1/health
```

The demo serves the search box on its home page. It has no database, no secrets and no authentication. It holds eleven sample items in memory and accepts any caller as one fixed demo person. Only health and search answer. Every other `/api/v1` call answers 404.

To redeploy, log in to Cloudflare with your own account and run:

```sh
npm ci
npm run build
npm run deploy:demo
```

The script runs `wrangler deploy` with `wrangler.demo.jsonc` and turns wrangler telemetry off. Keep the Cloudflare token in your shell. Do not commit it. Do not add it as a CI secret.

## Account export and erase

A trusted host imports `searchAccount` from `agentic-search/account`. It has the
`AccountPackage<SearchAccountDeps>` shape of the identity account registry:
`id`, `exportAccount(subject, deps)`, and `eraseAccount(subject, deps)`.
The installed identity 0.9 release has the older `AccountApp` interface. Use a
host adapter until the registry release is installed.

```ts
import { searchAccount } from "agentic-search/account";

const deps = { store, vectors: null }; // null only when search uses no vectors
const data = await searchAccount.exportAccount({ id: "ada", kind: "human" }, deps);
const counts = await searchAccount.eraseAccount({ id: "ada", kind: "human" }, deps);
```

The export has plain JSON collections `items` and `vectors`. Items include their
full indexed title, text, resource reference, owner, and time. Vector stores must
also implement `listByOwner(owner, { limit, after })`, ordered by id, including
orphan vectors. `MemoryVectorStore` implements it. Pass the same stores used by
search. Erase removes vectors first, then the index rows and postings. Errors
propagate. A retry finishes an interrupted erase; a completed repeat counts zero.
Damaged selected rows, foreign owners, and repeated ids stop both calls.

Authorize the request in the host before calling. This is a privileged account
API, with no search access filter. Stop indexing and other writes during export
and erase. Owner ids must be unique across all principal kinds: the index stores
an owner id without a kind. All principal kinds are accepted. With the default
owner policy, delegated agents write under their `actingFor` owner in the search
service. Export or erase that
owner to include those copies. Independent agents use their own owner id.

Each index copy has one owner. Erase removes that owner's copies even when the
source is shared. Copies owned by others, and the source itself, stay. The source
package must drop the subject's sharing grants and apply its shared-owner rules.
Search stores no versions, history, sharing grants, blobs, or author identity.
It cannot find contributions authored by the subject in another owner's text,
or label that text as machine-made. Run source account contributors as well;
they own authorship labels and erase. Refresh or remove affected index copies
before searches resume, so stale text from a source erase does not stay here.

## Limits

- The memory index scans every item per query. Use it for tests and small sets.
- One search call scans at most 1000 store hits. When hidden items fill that window, the page can be short or empty and still carries `nextCursor`. Keep paging until it ends. A cursor on an empty page shows that the scan window held more matches, some of them maybe hidden from the caller. Treat it as a known signal until stores can filter by access.
- The D1 adapter reads every posting in the range of the last query term. A very short last term is slow on a large index. An item may hold up to 500,000 characters, so keep an eye on D1 row and statement size limits.
- Ranking uses no corpus statistics (no document frequency, no average length), so hidden items never change the order a caller sees. The price is less weight for rare words.
- The CLI and MCP index is one JSON file for one machine. It has no cross-machine sharing.
- The vector port has no filter, so a store with very many hidden items can make hybrid search slower. No vector adapter ships besides the memory one.
- The search box shows one page of results. It has no "load more" yet, so a result past `limit` is out of reach. Narrow the query or raise `limit`.
- The search box is a field with a panel. It does not open a full-screen dialog.
- The default Worker needs the identity tables in its `DB` binding. Issue credentials with `agentic-identity`. See HTTP API.

## Develop

```sh
npm ci
npm run ci:local
```

`ci:local` also runs the browser tests (`npm run test:e2e`). Set `SEARCH_E2E_PORT` to use another port when the default 8792 is busy. They need Chromium: run `npx playwright install chromium` once. `npm run build` makes `demo-dist` first, and the tests serve it with the demo Worker.

## License

MIT.
