import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The demo page uses the typed client and the ui export from source.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../demo-dist", import.meta.url)), emptyOutDir: true },
});
