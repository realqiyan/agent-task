// Release gate: inspect npm's actual pack list, not the working tree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(pkg.name, "@realqiyan/agent-task");
assert.equal(pkg.license, "MIT");
assert(!pkg.private);
assert.equal(pkg.publishConfig.tag, "latest");
for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert(!pkg.scripts[hook], "Consumer installation must not build or run lifecycle hooks");
const packed = spawnSync("npm", ["pack", "--json"], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 120000 });
assert.equal(packed.status, 0, "npm pack failed; run npm run build separately for diagnostics");
const [artifact] = JSON.parse(packed.stdout);
const allowedScripts = new Set(["setup", "setup-wizard", "install-lib", "service-runner", "probe-agent", "mcp-call"].map(name => "scripts/" + name + ".mjs"));
const hostFiles = [
  ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json",
  "hosts/agent-task/package.json", "hosts/agent-task/.codex-plugin/plugin.json",
  "hosts/agent-task/.claude-plugin/plugin.json", "hosts/agent-task/mcp.json",
  "hosts/agent-task/README.md", "hosts/agent-task/LICENSE",
  "hosts/agent-task/pi-extension.js", "hosts/agent-task/hooks/claude.json", "hosts/agent-task/hooks/codex.json",
  "hosts/agent-task/scripts/preflight.mjs", "hosts/agent-task/scripts/session-start.mjs",
  "hosts/agent-task/skills/using-agent-task/SKILL.md",
  "hosts/agent-task/skills/using-agent-task/references/installation.md",
  "hosts/agent-task/skills/using-agent-task/references/tasks.md",
  "hosts/agent-task/skills/using-agent-task/references/troubleshooting.md",
];
for (const path of ["hosts/agent-task/package.json", "hosts/agent-task/.codex-plugin/plugin.json", "hosts/agent-task/.claude-plugin/plugin.json"]) {
  assert.equal(JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8")).version, pkg.version, "Host plugin version differs: " + path);
}
const allowedFiles = new Set(["package.json", "README.md", "CONTEXT.md", "LICENSE", "config.example.json", "bin/agent-task.mjs", ...hostFiles]);
for (const { path } of artifact.files) {
  assert(allowedFiles.has(path) || allowedScripts.has(path) ||
    /^dist\/(?:[a-z0-9-]+\/)+[a-z0-9-]+\.js$/.test(path) || /^dist\/web\/[a-z0-9-]+\.(js|css|html)$/.test(path) ||
    /^docs\/(?:adr\/)?[a-z0-9-]+\.md$/.test(path), "Unexpected package entry: " + path);
}
const paths = new Set(artifact.files.map(file => file.path));
for (const required of [...hostFiles, ...allowedScripts, "LICENSE", "bin/agent-task.mjs", "dist/application/main.js", "dist/application/mcp-entry.js", "dist/protocol/stdio.js", "dist/integrations/acp/discovery.js", "dist/integrations/acp/worker.js", "dist/web/index.html", "dist/web/app.js", "dist/web/style.css"]) assert(paths.has(required), "Missing runtime entry: " + required);
console.log(JSON.stringify({ filename: resolve(artifact.filename), version: artifact.version, files: paths.size, unpackedSize: artifact.unpackedSize }));
