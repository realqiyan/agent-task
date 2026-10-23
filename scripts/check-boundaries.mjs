// Check the actual source graph, including type imports, re-exports and literal dynamic imports.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/", import.meta.url));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
}
const roles = {
  model: ["tasks/model.ts", "executors/model.ts", "configuration/model.ts"],
  port: ["tasks/ports.ts", "configuration/ports.ts", "results/ports.ts", "executors/ports.ts"],
  rule: ["shared/time.ts", "shared/limits.ts", "shared/errors.ts", "tasks/graph.ts", "tasks/schedule.ts", "tasks/human-input.ts",
    "executors/permissions.ts", "executors/environment.ts", "configuration/policy.ts", "configuration/environment.ts"],
  schema: ["shared/validation.ts", "tasks/validation.ts", "tasks/storage/records.ts", "executors/validation.ts", "configuration/contract.ts"],
  service: ["tasks/definitions.ts", "tasks/runs.ts", "tasks/supervisor.ts", "tasks/sessions.ts", "executors/registry.ts",
    "results/service.ts", "configuration/settings.ts", "configuration/management.ts"],
  storage: ["tasks/storage/store.ts", "results/files.ts", "configuration/files.ts"],
};
function role(path) {
  for (const [name, entries] of Object.entries(roles)) if (entries.includes(path)) return name;
  for (const name of ["application", "protocol", "integrations", "infrastructure"]) if (path.startsWith(name + "/")) return name;
  throw new Error("Unclassified source; declare its responsibility: " + path);
}
const allowed = {
  model: ["model"], port: ["model", "port"], rule: ["model", "rule"], schema: ["model", "rule", "schema"],
  service: ["model", "port", "rule", "schema", "service"],
  storage: ["model", "port", "rule", "schema", "storage", "infrastructure"],
  infrastructure: ["infrastructure", "rule"],
  integrations: ["model", "port", "rule", "schema", "service", "storage", "infrastructure", "integrations"],
  protocol: ["model", "port", "rule", "schema", "service", "protocol"],
  application: ["model", "port", "rule", "schema", "service", "storage", "infrastructure", "integrations", "protocol", "application"],
};
// The CLI reads private startup inputs and controls the launcher through a local transport.
const adapterEdges = new Set([
  "protocol/cli/admin-client.ts -> configuration/files.ts",
  "protocol/cli/admin-client.ts -> integrations/local-service/control.ts",
  "protocol/cli/commands.ts -> integrations/local-service/control.ts",
  "protocol/mcp.ts -> infrastructure/version.ts",
  "protocol/stdio.ts -> infrastructure/version.ts",
]);
const modules = {
  shared: ["shared"], tasks: ["tasks", "executors", "shared"],
  executors: ["executors", "configuration", "shared"],
  configuration: ["configuration", "executors", "shared", "infrastructure"],
  results: ["results", "shared"], infrastructure: ["infrastructure", "shared"],
};
const paths = files(root).map(path => relative(root, path).replaceAll("\\", "/")).sort();
const graph = new Map(paths.map(path => [path, new Set()]));
const errors = [];
function dependency(source, specifier, typeOnly = false) {
  const from = role(source);
  if (!specifier.startsWith(".")) {
    const pure = from === "schema" && specifier === "zod";
    const utility = from === "service" && ["node:crypto", "node:util"].includes(specifier);
    const outer = ["application", "protocol", "integrations", "infrastructure", "storage"].includes(from);
    if (!pure && !utility && !outer) errors.push(source + " cannot import " + specifier);
    if (specifier.startsWith("@") && !((source.startsWith("integrations/coordinator/") && specifier.startsWith("@earendil-works/")) ||
      (source.startsWith("integrations/acp/") && specifier.startsWith("@agentclientprotocol/")) ||
      (["protocol/mcp.ts", "protocol/http/server.ts", "protocol/stdio.ts"].includes(source) && specifier.startsWith("@modelcontextprotocol/")))) {
      errors.push("SDK outside its adapter: " + source + " -> " + specifier);
    }
    return;
  }
  const target = relative(root, resolve(root, dirname(source), specifier)).replaceAll("\\", "/").replace(/\.js$/, ".ts");
  if (!graph.has(target)) { errors.push("Unresolved source dependency: " + source + " -> " + specifier); return; }
  graph.get(source).add(target);
  const edge = source + " -> " + target;
  if (!allowed[from].includes(role(target)) && !adapterEdges.has(edge)) errors.push("Forbidden layer dependency: " + edge);
  const domain = source.split("/")[0], destination = target.split("/")[0];
  const managementQuery = source === "configuration/management.ts" && target === "tasks/definitions.ts" && typeOnly;
  if (modules[domain] && !modules[domain].includes(destination) && !managementQuery && !(from === "storage" && destination === "infrastructure")) errors.push("Forbidden capability dependency: " + edge);
}
for (const path of paths) {
  const source = ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, true);
  const kind = role(path);
  if (["model", "port"].includes(kind)) {
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) &&
        !(ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly)) errors.push("Data/port module contains runtime behavior: " + path);
    }
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      dependency(path, node.moduleSpecifier.text, node.isTypeOnly || node.importClause?.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      dependency(path, node.argument.literal.text, true);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) errors.push("Nonliteral module load: " + path);
      else dependency(path, node.arguments[0].text);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" &&
      node.arguments?.[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.endsWith(".js")) {
      dependency(path, node.arguments[0].text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "commitRun" && path !== "tasks/runs.ts") {
      errors.push("Run writes must pass through TaskRuns: " + path);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const visited = new Set(), visiting = [];
function visit(path) {
  if (visiting.includes(path)) { errors.push("Dependency cycle: " + [...visiting.slice(visiting.indexOf(path)), path].join(" -> ")); return; }
  if (visited.has(path)) return;
  visiting.push(path);
  for (const next of graph.get(path)) visit(next);
  visiting.pop(); visited.add(path);
}
for (const path of paths) visit(path);
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log("Dependency boundaries OK (" + paths.length + " TypeScript modules; type and runtime edges checked)");
