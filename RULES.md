# agentic-search rules

These rules bind every run of agentic-search. They also bind agents
that drive it over MCP.

1. Filter before you return. Access is checked before results, counts
   and snippets.
2. Fail closed. A bad principal, a bad cursor or a bad filter result
   denies. It never allows.
3. Keep logs free of personal data. No titles, text or owner ids.
4. Erase fully. Erase by owner or by item removes the text, the
   metadata and the vectors.
5. Report failures as failures. Callers surface the error.
