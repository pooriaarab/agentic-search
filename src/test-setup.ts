import { rmSync } from "node:fs";
import { build } from "tsup";

/** Build the real package layout once, so tests run the shipped entry files. */
export default async function setup(): Promise<() => void> {
  await build({ config: "tsup.config.ts", outDir: "dist-test", dts: false, clean: true, silent: true });
  return () => rmSync("dist-test", { recursive: true, force: true });
}
