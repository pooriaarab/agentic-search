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
  ],
  format: ["esm"],
  dts: true,
  clean: true,
});
