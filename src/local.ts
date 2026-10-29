import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIndex } from "./core/memory-index.js";
import { createSearch, type SearchService } from "./core/service.js";
import type { IndexedItem, IndexStore, StoreHit, StoreQuery } from "./core/types.js";
import { parseItem } from "./core/validate.js";

/**
 * Local-file index store for the CLI and the MCP server. It keeps every item
 * in one JSON file and searches through the memory index. Use it for one
 * writer and small data sets. A corrupt file throws: it is never read as empty.
 */
export class FileIndex implements IndexStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<IndexedItem[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error("the index file is not a list");
    return data.map(parseItem);
  }

  private async write(items: IndexedItem[]): Promise<void> {
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(items), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  private async memory(): Promise<MemoryIndex> {
    const m = new MemoryIndex();
    await m.upsert(await this.read());
    return m;
  }

  async upsert(items: IndexedItem[]): Promise<void> {
    const byId = new Map((await this.read()).map((i) => [i.id, i]));
    for (const item of items) byId.set(item.id, item);
    await this.write([...byId.values()]);
  }

  async get(id: string): Promise<IndexedItem | null> {
    return (await this.read()).find((i) => i.id === id) ?? null;
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.read();
    const rest = all.filter((i) => i.id !== id);
    if (rest.length === all.length) return false;
    await this.write(rest);
    return true;
  }

  async removeByOwner(owner: string): Promise<number> {
    const all = await this.read();
    const rest = all.filter((i) => i.owner !== owner);
    if (rest.length !== all.length) await this.write(rest);
    return all.length - rest.length;
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
    key = randomBytes(32).toString("hex");
    await writeFile(keyPath, key, { mode: 0o600, flag: "wx" }).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
      key = (await readFile(keyPath, "utf8")).trim();
    });
  }
  return createSearch({ store: new FileIndex(join(dir, "index.json")), cursorSecret: key });
}
