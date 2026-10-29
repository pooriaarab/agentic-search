-- Same statements as D1_SCHEMA. Apply with: wrangler d1 migrations apply <database>
CREATE TABLE IF NOT EXISTS search_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  owner TEXT NOT NULL,
  res_type TEXT NOT NULL,
  res_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  length INTEGER NOT NULL
  );
CREATE INDEX IF NOT EXISTS search_items_owner ON search_items (owner, id);
CREATE TABLE IF NOT EXISTS search_postings (
  term TEXT NOT NULL,
  id TEXT NOT NULL,
  tf INTEGER NOT NULL,
  PRIMARY KEY (term, id)
  ) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS search_postings_id ON search_postings (id);
