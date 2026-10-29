# agentic-search

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Source](https://github.com/pooriaarab/agentic-search) · [Support](https://github.com/pooriaarab/agentic-search/issues)

Search and indexing for documents, sheets, slides, files and comments, for people and agents. Ports and adapters, Cloudflare first.

**Status:** version 0.0.0. This is the project scaffold. The search core is not built yet.

## Install

```sh
npm install agentic-search
```

Requires Node.js 20 or later.

## What works now

- `npx agentic-search --version` prints the version.
- `npx agentic-search mcp` starts an MCP server with no tools.
- The Worker answers `GET /health`.

## Limits

No indexing and no search exist yet.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
