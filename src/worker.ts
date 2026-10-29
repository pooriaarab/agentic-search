import { VERSION } from "./version.js";

export interface WorkerEnv {
  SEARCH_NAME?: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/v1/health")) {
      return json({ ok: true, name: env.SEARCH_NAME ?? "agentic-search", version: VERSION });
    }
    return json({ error: "not found" }, 404);
  },
};
