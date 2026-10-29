import { ValidationError } from "./errors.js";

export interface CursorPosition {
  score: number;
  id: string;
}

export const MIN_SECRET_BYTES = 32;

/** Short checksum that ties a cursor to the query and caller that made it. */
export function queryDigest(parts: unknown): string {
  const s = JSON.stringify(parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface CursorCodec {
  encode(pos: CursorPosition, digest: string): Promise<string>;
  decode(cursor: string, digest: string): Promise<CursorPosition>;
}

/**
 * Cursors are sealed with AES-GCM. The score inside comes from index-wide
 * statistics, so it must stay unreadable to callers. The secret must hold at
 * least 32 bytes. A missing or short secret throws.
 */
export async function createCursorCodec(secret: unknown): Promise<CursorCodec> {
  const raw =
    typeof secret === "string"
      ? new TextEncoder().encode(secret)
      : secret instanceof Uint8Array
        ? secret
        : undefined;
  if (raw === undefined || raw.byteLength < MIN_SECRET_BYTES) {
    throw new Error(`cursorSecret must hold at least ${MIN_SECRET_BYTES} bytes`);
  }
  const material = await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>);
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async encode(pos, digest) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify({ s: pos.score, i: pos.id, q: digest }));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
      const out = new Uint8Array(iv.length + sealed.length);
      out.set(iv);
      out.set(sealed, iv.length);
      return toB64Url(out);
    },
    async decode(cursor, digest) {
      const bad = new ValidationError("invalid cursor");
      if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1024) throw bad;
      let parsed: unknown;
      try {
        const bytes = fromB64Url(cursor);
        if (bytes.length < 13) throw bad;
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
      } catch {
        throw bad;
      }
      if (typeof parsed !== "object" || parsed === null) throw bad;
      const { s, i, q } = parsed as Record<string, unknown>;
      if (typeof s !== "number" || !Number.isFinite(s)) throw bad;
      if (typeof i !== "string" || i.length === 0) throw bad;
      if (q !== digest) throw bad;
      return { score: s, id: i };
    },
  };
}
