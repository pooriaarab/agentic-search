import { createWorker, type WorkerEnv } from "./worker.js";
import { createSearch, type SearchService } from "./core/service.js";
import { MemoryIndex } from "./core/memory-index.js";
import type { IndexedItem, Principal } from "./core/types.js";

// The public demo Worker. It serves the demo page and a read-only search API over sample items
// that sit in memory. It has no sign-in and no database, so it accepts any caller as one fixed
// demo person, and it refuses every route except search and health.
const DEMO: Principal = { id: "demo", kind: "human" };
const DAY = 86_400_000;

const item = (id: string, kind: IndexedItem["kind"], title: string, text: string, daysAgo: number): IndexedItem => ({
  id,
  kind,
  title,
  text,
  owner: DEMO.id,
  resource: { type: kind, id },
  updatedAt: Date.UTC(2026, 9, 1) - daysAgo * DAY,
});

const SAMPLES: IndexedItem[] = [
  item("d1", "document", "Launch plan", "The launch plan covers the budget, the timeline and who signs off on the release.", 2),
  item("d2", "document", "Budget notes", "Notes from the budget review. The travel budget stays flat this year.", 9),
  item("d3", "document", "Meeting notes, March", "We agreed on the launch date and moved the budget review to Friday.", 30),
  item("s1", "sheet", "Budget 2026", "Rows for travel, hosting and tools. Totals by quarter with a variance column.", 4),
  item("s2", "sheet", "Launch checklist", "A checklist of tasks for the launch. Owner, due date and status for each task.", 6),
  item("p1", "slide", "Launch review", "Slides for the launch review: goals, budget, risks and next steps.", 3),
  item("p2", "slide", "Team offsite", "Agenda, travel plans and the budget for the team offsite.", 40),
  item("f1", "file", "invoice-budget-q3.pdf", "Invoice for hosting in the third quarter, paid against the budget.", 12),
  item("f2", "file", "logo-launch.svg", "The logo used on launch day.", 15),
  item("c1", "comment", "Comment on Launch plan", "Can we cut the budget line for travel before the launch?", 1),
  item("c2", "comment", "Comment on Budget 2026", "The hosting row looks too high. Please check the quarter totals.", 5),
];

let service: Promise<SearchService> | undefined;
function seeded(): Promise<SearchService> {
  service ??= (async () => {
    const svc = await createSearch({ store: new MemoryIndex(), cursorSecret: "demo-cursor-secret-demo-cursor-secret" });
    await svc.index(DEMO, SAMPLES);
    return svc;
  })();
  service.catch(() => (service = undefined));
  return service;
}

const api = createWorker({ verifier: { verify: async () => DEMO }, service: seeded });

export interface DemoEnv extends WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path.startsWith("/api/")) {
      const open =
        (request.method === "GET" && (path === "/api/v1/health" || path === "/api/health")) ||
        (request.method === "POST" && path === "/api/v1/search");
      if (!open) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
      return api.fetch(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
