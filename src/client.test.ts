// The client against the real Worker handler: every request goes through createWorker, with a real
// service over the memory index, a real verifier, and sealed cursors.
import { describe, expect, test } from "vitest";
import { createClient, SearchApiError, type SearchClient } from "./client.js";
import { MemoryIndex } from "./core/memory-index.js";
import { ownerPolicy } from "./core/access.js";
import { createSearch } from "./core/service.js";
import type { Principal } from "./core/types.js";
import { createWorker, type AuthVerifier } from "./worker.js";
import { VERSION } from "./version.js";

const ANN = `ann-${"a".repeat(40)}`;
const BEN = `ben-${"b".repeat(40)}`;
const PEOPLE: Record<string, Principal> = { [ANN]: { id: "ann", kind: "human" }, [BEN]: { id: "ben", kind: "human" } };
const verifier: AuthVerifier = {
  async verify(request) {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    return (bearer !== undefined && PEOPLE[bearer]) || null;
  },
};
const item = (id: string, owner: string, text: string) => ({
  id,
  kind: "document" as const,
  title: `Title ${id}`,
  text,
  owner,
  resource: { type: "doc", id: `r-${id}` },
  updatedAt: 1000,
});

async function setup() {
  const service = await createSearch({ store: new MemoryIndex(), cursorSecret: "s".repeat(40), access: ownerPolicy });
  const worker = createWorker({ verifier, service: async () => service });
  const seen: { url: string; init: RequestInit }[] = [];
  const handler = ((input: string, init: RequestInit) => {
    seen.push({ url: input, init });
    return worker.fetch(new Request(input, init), {});
  }) as unknown as typeof fetch;
  const as = (token: string): SearchClient => createClient({ baseUrl: "https://search.test", token, fetch: handler });
  return { as, seen };
}

async function refusal(promise: Promise<unknown>): Promise<SearchApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SearchApiError);
  return error as SearchApiError;
}

describe("createClient against the Worker handler", () => {
  test("walks every route", async () => {
    const { as } = await setup();
    const ann = as(ANN);
    const ben = as(BEN);

    expect(await ann.health()).toEqual({ ok: true, name: "agentic-search", version: VERSION });
    expect(await ann.index([item("a", "ann", "quarterly budget plan"), item("b", "ann", "budget notes")])).toEqual({ indexed: 2 });
    expect(await ann.index(item("c", "ann", "budget three"))).toEqual({ indexed: 1 });
    await ben.index(item("z", "ben", "private budget of someone else"));

    const mine = await ann.search({ query: "budget" });
    expect(mine.hits.map((h) => h.id).sort()).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(mine)).not.toContain("someone else");

    const first = await ann.search({ query: "budget", limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await ann.search({ query: "budget", limit: 2, cursor: first.nextCursor });
    expect([...first.hits, ...second.hits].map((h) => h.id).sort()).toEqual(["a", "b", "c"]);

    expect(await ann.remove("c")).toEqual({ removed: true });
    expect(await ann.remove("z")).toEqual({ removed: false });
    expect((await ann.search({ query: "budget" })).hits).toHaveLength(2);

    const exported = await ann.exportOwner("ann");
    expect(exported.owner).toBe("ann");
    expect(exported.items.map((i) => i.id).sort()).toEqual(["a", "b"]);

    expect(await ann.eraseOwner("ann")).toEqual({ removed: 2 });
    expect((await ann.search({ query: "budget" })).hits).toEqual([]);
    expect((await ben.search({ query: "budget" })).hits).toHaveLength(1);
  });

  test("an error carries a code from the HTTP status", async () => {
    const { as } = await setup();
    const ann = as(ANN);
    const cases: [Promise<unknown>, number, string][] = [
      [as("x".repeat(40)).search({ query: "a" }), 401, "UNAUTHENTICATED"],
      [ann.search({ query: 5 } as never), 400, "INVALID_INPUT"],
      [ann.index({ id: "x" } as never), 400, "INVALID_INPUT"],
      [ann.exportOwner("ben"), 403, "FORBIDDEN"],
      [ann.eraseOwner("ben"), 403, "FORBIDDEN"],
    ];
    for (const [call, status, code] of cases) {
      const error = await refusal(call);
      expect([error.status, error.code]).toEqual([status, code]);
    }
  });

  test("an id is encoded, and a dot segment is refused before any request", async () => {
    const { as, seen } = await setup();
    const ann = as(ANN);
    for (const id of ["", ".", ".."]) await expect(ann.remove(id)).rejects.toThrow(TypeError);
    expect(await ann.remove("a/b")).toEqual({ removed: false });
    expect(await ann.remove("%2e")).toEqual({ removed: false });
    expect(seen.map((s) => s.url)).toEqual(["https://search.test/api/v1/items/a%2Fb", "https://search.test/api/v1/items/%252e"]);
  });

  test("a reply that is not the expected shape fails as UNKNOWN", async () => {
    const proxy = (body: string, status = 200) => createClient({ baseUrl: "https://c.test/base/", token: ANN, fetch: (async () => new Response(body, { status })) as typeof fetch });
    const wrong = await refusal(proxy("<html>").search({ query: "a" }));
    expect([wrong.code, wrong.status]).toEqual(["UNKNOWN", 200]);
    expect((await refusal(proxy("[1]").exportOwner("ann"))).code).toBe("UNKNOWN");
    const gateway = await refusal(proxy("bad gateway", 502).remove("a"));
    expect([gateway.code, gateway.status, gateway.message]).toEqual(["UNKNOWN", 502, "HTTP 502"]);
    const big = await refusal(proxy(JSON.stringify({ error: "body is too large" }), 413).index([]));
    expect([big.code, big.message]).toEqual(["TOO_LARGE", "body is too large"]);
  });

  test("the base URL keeps its path, and a bad option is refused", async () => {
    const urls: string[] = [];
    const client = createClient({ baseUrl: "https://c.test/base/", token: ANN, fetch: (async (u: string) => (urls.push(u), new Response("{}", { status: 500 }))) as never });
    await refusal(client.health());
    expect(urls).toEqual(["https://c.test/base/api/v1/health"]);
    for (const baseUrl of ["", "nope", "ftp://x.test", "https://x.test/?a=1", "https://x.test/#h", "https://u:p@x.test"]) {
      expect(() => createClient({ baseUrl, token: ANN })).toThrow(TypeError);
    }
    expect(() => createClient({ baseUrl: "https://x.test", token: "" })).toThrow(TypeError);
  });

  test("a custom fetch is called with no this", async () => {
    const holder = {
      fetch(this: unknown): Promise<Response> {
        if (this !== undefined) throw new TypeError("Illegal invocation");
        return Promise.resolve(Response.json({ ok: true, name: "n", version: "v" }));
      },
    };
    expect(await createClient({ baseUrl: "https://c.test", token: ANN, fetch: holder.fetch }).health()).toMatchObject({ ok: true });
  });

  test("an aborted call rejects with the signal reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const slow = createClient({ baseUrl: "https://c.test", token: ANN, fetch: ((_u: string, init: RequestInit) => (init.signal?.aborted ? Promise.reject(init.signal.reason) : Promise.resolve(new Response("{}")))) as never });
    await expect(slow.health({ signal: controller.signal })).rejects.toThrow("stop");
  });
});
