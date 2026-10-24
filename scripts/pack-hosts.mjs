// Pack the dependency-free host bundle without building or installing the service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../hosts/agent-task/", import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const pkg = json("package.json");
const project = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert(process.argv.length <= 3, "Usage: node scripts/pack-hosts.mjs [output-directory]");
const destination = resolve(process.argv[2] ?? fileURLToPath(new URL("..", root)));
assert.equal(pkg.name, "@realqiyan/agent-task-hosts");
assert.equal(pkg.version, project.version);
assert.equal(pkg.license, "MIT");
assert(!pkg.private);
assert.equal(pkg.publishConfig.access, "public");
assert.equal(pkg.publishConfig.tag, "latest");
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "scripts", "bin"]) {
  assert(!pkg[field], "Host installation must not install or execute the service: " + field);
}
for (const path of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) assert.equal(json(path).version, pkg.version);
const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
  cwd: root, encoding: "utf8", timeout: 30_000,
});
assert.equal(packed.status, 0, "Host package failed to pack: " + packed.stderr);
const [artifact] = JSON.parse(packed.stdout);
const required = [
  "package.json", "README.md", "LICENSE", "mcp.json",
  "pi-extension.js", "hooks/claude.json", "hooks/codex.json",
  "scripts/preflight.mjs", "scripts/session-start.mjs",
  ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
  "skills/using-agent-task/SKILL.md",
  "skills/using-agent-task/references/installation.md",
  "skills/using-agent-task/references/tasks.md",
  "skills/using-agent-task/references/troubleshooting.md",
];
assert.deepEqual(artifact.files.map(file => file.path).sort(), required.sort(), "Unexpected or missing host asset");
console.log(JSON.stringify({ filename: resolve(destination, artifact.filename), version: artifact.version, files: artifact.files.length }));
