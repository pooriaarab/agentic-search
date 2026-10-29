import { ValidationError } from "./errors.js";

export interface CursorPosition {
  score: number;
  id: string;
}

/** Short checksum that ties a cursor to the query that made it. Not a secret. */
export function queryDigest(parts: unknown): string {
  const s = JSON.stringify(parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unb64(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** A cursor names the last item the caller already received. It never names a hidden item. */
export function encodeCursor(pos: CursorPosition, digest: string): string {
  return b64(JSON.stringify({ s: pos.score, i: pos.id, q: digest }));
}

export function decodeCursor(cursor: string, digest: string): CursorPosition {
  const bad = new ValidationError("invalid cursor");
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1024) throw bad;
  let raw: unknown;
  try {
    raw = JSON.parse(unb64(cursor));
  } catch {
    throw bad;
  }
  if (typeof raw !== "object" || raw === null) throw bad;
  const { s, i, q } = raw as Record<string, unknown>;
  if (typeof s !== "number" || !Number.isFinite(s)) throw bad;
  if (typeof i !== "string" || i.length === 0) throw bad;
  if (q !== digest) throw bad;
  return { score: s, id: i };
}
