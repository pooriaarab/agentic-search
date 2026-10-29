import { analyzeItem } from "../core/analyze.js";
import { B, K1, LENGTH_PIVOT } from "../core/score.js";
import type { IndexedItem, IndexStore, StoreHit, StoreQuery } from "../core/types.js";
import { isItemKind } from "../core/validate.js";

/** The slice of the D1 API this adapter uses. A real `D1Database` fits. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
}
export interface D1ResultLike {
  results?: unknown[];
  meta?: { changes?: number };
}
interface D1Reader extends D1StatementLike {
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

/** Schema statements. Each one is safe to run again. */
export const D1_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS search_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    owner TEXT NOT NULL,
    res_type TEXT NOT NULL,
    res_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    length INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS search_items_owner ON search_items (owner, id)",
  `CREATE TABLE IF NOT EXISTS search_postings (
    term TEXT NOT NULL,
    id TEXT NOT NULL,
    tf INTEGER NOT NULL,
    PRIMARY KEY (term, id)
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS search_postings_id ON search_postings (id)",
];

/** Items per batch. One item always sits whole inside one batch, so it is atomic. */
const WRITE_CHUNK = 25;
const PREFIX_END = "\u{10ffff}";

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string;
  owner: string;
  res_type: string;
  res_id: string;
  updated_at: number;
  score?: number;
}

/** Fail closed: a row that is not a valid item throws. It never reaches the access filter. */
const toItem = (r: Row): IndexedItem => {
  const bad =
    !isItemKind(r.kind) ||
    ![r.id, r.owner, r.res_type].every((v) => typeof v === "string" && v.length > 0) ||
    typeof r.res_id !== "string" ||
    typeof r.title !== "string" ||
    typeof r.body !== "string" ||
    !Number.isInteger(r.updated_at);
  if (bad) throw new Error("search_items holds a row that is not a valid item");
  return rowToItem(r);
};

const rowToItem = (r: Row): IndexedItem => ({
  id: r.id,
  kind: r.kind as IndexedItem["kind"],
  title: r.title,
  text: r.body,
  owner: r.owner,
  resource: { type: r.res_type, id: r.res_id },
  updatedAt: r.updated_at,
});

/**
 * D1 index store. Items sit in one table. A posting table maps each term to
 * the items that hold it, so a query reads only the rows for its terms.
 * Scores come out of SQL and match the shape in `core/score.ts`.
 *
 * One query reads every posting in the range of its last term. A very short
 * last term is slow on a large index.
 *
 * Data residency: pick the D1 location hint when you create the database
 * (for example `wrangler d1 create <name> --location eu`).
 */
export class D1Index implements IndexStore {
  constructor(private readonly db: D1Like) {}

  /** Create the tables and indexes. Run it once at deploy time. */
  static async migrate(db: D1Like): Promise<void> {
    await db.batch(D1_SCHEMA.map((sql) => db.prepare(sql)));
  }

  private async rows(sql: string, ...params: unknown[]): Promise<Row[]> {
    const stmt = this.db.prepare(sql).bind(...params) as D1Reader;
    return (await stmt.all<Row>()).results;
  }

  async upsert(items: IndexedItem[]): Promise<void> {
    for (let i = 0; i < items.length; i += WRITE_CHUNK) {
      const stmts: D1StatementLike[] = [];
      for (const it of items.slice(i, i + WRITE_CHUNK)) {
        const { tf, length } = analyzeItem(it);
        stmts.push(
          this.db.prepare("DELETE FROM search_postings WHERE id = ?").bind(it.id),
          this.db
            .prepare(
              `INSERT OR REPLACE INTO search_items
               (id, kind, title, body, owner, res_type, res_id, updated_at, length)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(it.id, it.kind, it.title, it.text, it.owner, it.resource.type, it.resource.id, it.updatedAt, length),
        );
        if (tf.size > 0) {
          stmts.push(
            this.db
              .prepare(
                `INSERT INTO search_postings (term, id, tf)
                 SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]') FROM json_each(?)`,
              )
              .bind(it.id, JSON.stringify([...tf])),
          );
        }
      }
      // A batch is one transaction: a reader never sees an item without its postings.
      await this.db.batch(stmts);
    }
  }

  async get(id: string): Promise<IndexedItem | null> {
    const [row] = await this.rows("SELECT * FROM search_items WHERE id = ?", id);
    return row ? toItem(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.db.batch([
      this.db.prepare("DELETE FROM search_postings WHERE id = ?").bind(id),
      this.db.prepare("DELETE FROM search_items WHERE id = ?").bind(id),
    ]);
    return (res[1]?.meta?.changes ?? 0) > 0;
  }

  async removeByOwner(owner: string): Promise<number> {
    const res = await this.db.batch([
      this.db
        .prepare("DELETE FROM search_postings WHERE id IN (SELECT id FROM search_items WHERE owner = ?)")
        .bind(owner),
      this.db.prepare("DELETE FROM search_items WHERE owner = ?").bind(owner),
    ]);
    return res[1]?.meta?.changes ?? 0;
  }

  async listByOwner(owner: string, opts: { limit: number; after?: string }): Promise<IndexedItem[]> {
    const rows =
      opts.after === undefined
        ? await this.rows("SELECT * FROM search_items WHERE owner = ? ORDER BY id LIMIT ?", owner, opts.limit)
        : await this.rows(
            "SELECT * FROM search_items WHERE owner = ? AND id > ? ORDER BY id LIMIT ?",
            owner,
            opts.after,
            opts.limit,
          );
    return rows.map(toItem);
  }

  async search(q: StoreQuery): Promise<StoreHit[]> {
    const last = q.terms.length - 1;
    if (last < 0) return [];
    const params: unknown[] = [];
    const ctes: string[] = [];
    const joins: string[] = [];
    const scores: string[] = [];
    q.terms.forEach((term, i) => {
      if (i === last) {
        ctes.push(`t${i} AS (SELECT id, SUM(tf) AS tf FROM search_postings WHERE term >= ? AND term < ? GROUP BY id)`);
        params.push(term, term + PREFIX_END);
      } else {
        ctes.push(`t${i} AS (SELECT id, SUM(tf) AS tf FROM search_postings WHERE term = ? GROUP BY id)`);
        params.push(term);
      }
      joins.push(`JOIN t${i} ON t${i}.id = i.id`);
      scores.push(`(t${i}.tf * ${K1 + 1}) / (t${i}.tf + ${K1} * (${1 - B} + ${B} * i.length / ${LENGTH_PIVOT.toFixed(1)}))`);
    });
    const where: string[] = [];
    const f = q.filter;
    if (f.kinds !== undefined) {
      if (f.kinds.length === 0) return [];
      where.push(`i.kind IN (${f.kinds.map(() => "?").join(", ")})`);
      params.push(...f.kinds);
    }
    if (f.owner !== undefined) (where.push("i.owner = ?"), params.push(f.owner));
    if (f.resource !== undefined) {
      where.push("i.res_type = ?");
      params.push(f.resource.type);
      if (f.resource.id !== undefined) (where.push("i.res_id = ?"), params.push(f.resource.id));
    }
    if (f.updatedAfter !== undefined) (where.push("i.updated_at > ?"), params.push(f.updatedAfter));
    if (f.updatedBefore !== undefined) (where.push("i.updated_at < ?"), params.push(f.updatedBefore));
    const outer: string[] = [];
    if (q.after !== undefined) {
      outer.push("WHERE (score < ? OR (score = ? AND id > ?))");
      params.push(q.after.score, q.after.score, q.after.id);
    }
    params.push(q.limit);
    const sql = `WITH ${ctes.join(", ")},
      scored AS (
        SELECT i.id AS id, i.kind, i.title, i.body, i.owner, i.res_type, i.res_id, i.updated_at,
               ${scores.join(" + ")} AS score
        FROM search_items i ${joins.join(" ")}
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      )
      SELECT * FROM scored ${outer.join(" ")} ORDER BY score DESC, id ASC LIMIT ?`;
    const rows = await this.rows(sql, ...params);
    return rows.map((r) => ({ item: toItem(r), score: r.score as number }));
  }
}
