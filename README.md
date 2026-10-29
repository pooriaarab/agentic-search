# agentic-search

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Source](https://github.com/pooriaarab/agentic-search) · [Support](https://github.com/pooriaarab/agentic-search/issues)

Search and indexing for documents, sheets, slides, files and comments, for people and agents. Ports and adapters, Cloudflare first.

**Status:** version 0.0.0, early. The core library works: model, memory index, access filter, erase and export. The D1 adapter, Worker API, CLI and MCP tools come in later pull requests.

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
- **Ranking.** BM25. Title words count three times.
- **Snippets.** A text window with highlight offsets. No HTML is produced.
- **Pagination.** A sealed cursor (AES-GCM, key from `cursorSecret`). Callers cannot read it. It works only for the query and caller that made it. A missing or short secret throws.
- **Access.** Inject an `AccessPolicy`. The default lets a principal read only what its subject owns. The service checks the policy before it returns any hit, snippet or cursor. Only an answer of exactly `true` allows. A malformed answer throws.
- **No counts.** A page has no total, because a total would leak hidden items.
- **Principals.** Every call takes a principal with a required `kind`. Agent principals act for a subject.
- **Privacy.** `eraseOwner` and `remove` delete data. `exportOwner` returns everything indexed for one owner. Logs hold counts only.
- **Testing your own store.** `agentic-search/testing` exports `runIndexContract` for adapters.

## Limits

- The memory index scans every item per query. Use it for tests and small sets.
- One search call scans at most 1000 store hits. When hidden items fill that window, the page can be short or empty and still carries `nextCursor`. Keep paging until it ends.
- BM25 statistics span the whole index, so ranking can depend on hidden items in a small way. Scores are never returned, and cursors are sealed.
- No D1 adapter, HTTP API, CLI search commands or MCP tools yet.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
