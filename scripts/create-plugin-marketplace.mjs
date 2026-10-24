// Build a disposable local marketplace for unpublished plugin assets; no registry or host config changes.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/create-plugin-marketplace.mjs");
const root = mkdtempSync(join(tmpdir(), "agent-task-plugin-marketplace-"));
cpSync(new URL("../plugin/", import.meta.url), join(root, "plugin"), { recursive: true });
for (const [directory, source] of [
  [".claude-plugin", "./plugin"],
  [".agents/plugins", { source: "local", path: "./plugin" }],
]) {
  const catalog = JSON.parse(readFileSync(new URL("../" + directory + "/marketplace.json", import.meta.url), "utf8"));
  catalog.name = "agent-task-dev";
  catalog.plugins[0].source = source;
  mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, directory, "marketplace.json"), JSON.stringify(catalog, null, 2) + "\n");
}
console.log(root);
