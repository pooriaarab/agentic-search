import { MemoryIndex, type MemoryBacking } from "./memory-index.js";
import { runIndexContract } from "../testing/index-contract.js";

runIndexContract("memory", () => {
  const backing: MemoryBacking = new Map();
  return { store: new MemoryIndex(backing), peer: () => new MemoryIndex(backing) };
});
