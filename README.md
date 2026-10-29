# agentic-search

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Source](https://github.com/pooriaarab/agentic-search) · [Support](https://github.com/pooriaarab/agentic-search/issues)

Search and indexing for documents, sheets, slides, files and comments, for people and agents. Ports and adapters, Cloudflare first.

**Status:** version 0.1.0, early. The core library works: model, memory index, access filter, erase and export. The D1 adapter, the Worker API, the CLI and the MCP server work. The default Worker has no real authentication. See the HTTP API section.

## Install

```sh
npm install agentic-search
```

Requires Node.js 20 or later.

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

## How it works

- **Items.** An item has `id`, `kind` (`document`, `sheet`, `slide`, `file`, `comment`), `title`, `text`, `owner`, a `resource` reference and `updatedAt`.
- **Query.** Words are ANDed. The last word also matches as a prefix. Case and accents do not matter. Filters: kinds, owner, resource, time range.
- **Ranking.** BM25-shaped, with no corpus statistics. Title words count three times.
- **Snippets.** A text window with highlight offsets. No HTML is produced.
- **Pagination.** A sealed cursor (AES-GCM, key from `cursorSecret`). Callers cannot read it. It works only for the query and caller that made it. A missing or short secret throws.
- **Access.** Inject an `AccessPolicy`. The default lets a principal read only what its subject owns. The service checks the policy before it returns any hit, snippet or cursor. Only an answer of exactly `true` allows. A malformed answer throws.
- **No counts.** A page has no total, because a total would leak hidden items.
- **Principals.** Every call takes a principal with a required `kind`. Agent principals act for a subject.
- **Privacy.** `eraseOwner` and `remove` delete data. `exportOwner` returns everything indexed for one owner. Logs hold counts only.
- **D1.** `import { D1Index } from "agentic-search/d1"`. Run `D1Index.migrate(env.DB)` once, then pass `new D1Index(env.DB)` as `store`. Create the database with an EU location hint if you need EU residency.
- **Testing your own store.** `agentic-search/testing` exports `runIndexContract` for adapters.

## HTTP API

**Warning:** the default Worker export has no authentication. It refuses every `/api/v1` call (except health) unless you set `SEARCH_UNSAFE_NO_AUTH=1`. With that flag it trusts the headers `x-principal-id`, `x-principal-kind` and `x-principal-acting-for`. Use it for local trials only. For real use, call `createWorker({ verifier })` and pass your own `AuthVerifier`. Import it with `import { createWorker } from "agentic-search/worker"`. A verifier returns the principal, or `null` for no access. A throw also means no access.

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

## Limits

- The memory index scans every item per query. Use it for tests and small sets.
- One search call scans at most 1000 store hits. When hidden items fill that window, the page can be short or empty and still carries `nextCursor`. Keep paging until it ends. A cursor on an empty page shows that the scan window held more matches, some of them maybe hidden from the caller. Treat it as a known signal until stores can filter by access.
- The D1 adapter reads every posting in the range of the last query term. A very short last term is slow on a large index. An item may hold up to 500,000 characters, so keep an eye on D1 row and statement size limits.
- Ranking uses no corpus statistics (no document frequency, no average length), so hidden items never change the order a caller sees. The price is less weight for rare words.
- The default Worker has no real authentication. See HTTP API.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
