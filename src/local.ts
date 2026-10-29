import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIndex } from "./core/memory-index.js";
import { createSearch, type SearchService } from "./core/service.js";
import type { IndexedItem, IndexStore, StoreHit, StoreQuery } from "./core/types.js";
import { parseItem } from "./core/validate.js";

/**
 * Local-file index store for the CLI and the MCP server. It keeps every item
 * in one JSON file and searches through the memory index. Use it for one
 * writer and small data sets. A corrupt file throws: it is never read as empty.
 * Writes run one at a time per file, across processes too (a lock file next to
 * the index). Each call reads the file again, so a long scan can see a change
 * between pages.
 */
const queues = new Map<string, Promise<unknown>>();

export class FileIndex implements IndexStore {
  constructor(private readonly path: string) {}

  /** Run a read-change-write step after every earlier step on the same file. */
  private locked<T>(step: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      const release = await this.acquire();
      try {
        return await step();
      } finally {
        await release();
      }
    };
    const run = (queues.get(this.path) ?? Promise.resolve()).then(guarded, guarded);
    queues.set(this.path, run.catch(() => undefined));
    return run;
  }

  /** Take the lock file. A lock older than 30 seconds belongs to a dead process and is replaced. */
  private async acquire(): Promise<() => Promise<void>> {
    const lock = `${this.path}.lock`;
    for (let tries = 0; tries < 600; tries++) {
      try {
        await (await open(lock, "wx", 0o600)).close();
        return () => unlink(lock).catch(() => undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > 30_000) await unlink(lock).catch(() => undefined);
        else await new Promise((r) => setTimeout(r, 25));
      }
    }
    throw new Error("the index file is locked");
  }

  private async read(): Promise<IndexedItem[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error("not a list");
      return data.map(parseItem);
    } catch {
      // A storage failure, not a caller error: the message holds no stored data.
      throw new Error("the index file is corrupt");
    }
  }

  private async write(items: IndexedItem[]): Promise<void> {
    const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(items), { mode: 0o600 });
      await rename(tmp, this.path);
    } catch (error) {
      // Leave no copy of the data behind after a failed write.
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  private async memory(): Promise<MemoryIndex> {
    const m = new MemoryIndex();
    await m.upsert(await this.read());
    return m;
  }

  upsert(items: IndexedItem[]): Promise<void> {
    return this.locked(async () => {
      const byId = new Map((await this.read()).map((i) => [i.id, i]));
      for (const item of items) byId.set(item.id, item);
      await this.write([...byId.values()]);
    });
  }

  async get(id: string): Promise<IndexedItem | null> {
    return (await this.read()).find((i) => i.id === id) ?? null;
  }

  remove(id: string): Promise<boolean> {
    return this.locked(async () => {
      const all = await this.read();
      const rest = all.filter((i) => i.id !== id);
      if (rest.length === all.length) return false;
      await this.write(rest);
      return true;
    });
  }

  removeByOwner(owner: string): Promise<number> {
    return this.locked(async () => {
      const all = await this.read();
      const rest = all.filter((i) => i.owner !== owner);
      if (rest.length !== all.length) await this.write(rest);
      return all.length - rest.length;
    });
  }

  async listByOwner(owner: string, opts: { limit: number; after?: string }): Promise<IndexedItem[]> {
    return (await this.memory()).listByOwner(owner, opts);
  }

  async search(query: StoreQuery): Promise<StoreHit[]> {
    return (await this.memory()).search(query);
  }
}

/** Open the local service in `dir`. It creates the cursor key on first use. */
export async function openLocal(dir: string): Promise<SearchService> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, "cursor.key");
  let key: string;
  try {
    key = (await readFile(keyPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Write a temp file, then link it into place: a reader never sees a half-written key.
    const tmp = `${keyPath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
    await link(tmp, keyPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    await unlink(tmp);
    key = (await readFile(keyPath, "utf8")).trim();
  }
  return createSearch({ store: new FileIndex(join(dir, "index.json")), cursorSecret: key });
}
