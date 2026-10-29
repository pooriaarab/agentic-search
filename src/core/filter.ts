import type { IndexedItem, ItemFilter } from "./types.js";

/** True when an item satisfies every part of a filter. */
export function passes(item: IndexedItem, f: ItemFilter): boolean {
  if (f.kinds !== undefined && !f.kinds.includes(item.kind)) return false;
  if (f.owner !== undefined && item.owner !== f.owner) return false;
  if (f.resource !== undefined) {
    if (item.resource.type !== f.resource.type) return false;
    if (f.resource.id !== undefined && item.resource.id !== f.resource.id) return false;
  }
  if (f.updatedAfter !== undefined && !(item.updatedAt > f.updatedAfter)) return false;
  if (f.updatedBefore !== undefined && !(item.updatedAt < f.updatedBefore)) return false;
  return true;
}
