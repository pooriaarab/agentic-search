import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const PORT = 8792;
const wrangler = fileURLToPath(new URL("./node_modules/wrangler/bin/wrangler.js", import.meta.url));

// The tests run against the real demo Worker under `wrangler dev`. Run `npm run build` first.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.ui.spec.ts",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `node ${wrangler} dev --config wrangler.demo.jsonc --ip 127.0.0.1 --port ${PORT} --inspector-port ${PORT + 100}`,
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
