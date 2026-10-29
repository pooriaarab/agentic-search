import { copyFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/mcp.ts",
    "src/mcp-bin.ts",
    "src/worker.ts",
    "src/client.ts",
    "src/adapters/d1.ts",
    "src/testing/index-contract.ts",
    "src/ui/index.ts",
  ],
  external: ["react", "react-dom", "agentic-design"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  // The styles of ./ui ship as plain CSS.
  async onSuccess() {
    await copyFile("src/ui/search.css", "dist/ui.css");
  },
  format: ["esm"],
  dts: true,
  clean: true,
});
