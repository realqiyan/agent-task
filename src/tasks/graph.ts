import type { NodeDefinition } from "./model.js";

export function validateGraph(nodes: NodeDefinition[]): void {
  const graph = new Map(nodes.map(node => [node.id, node]));
  if (!nodes.length || nodes.length > 20 || graph.size !== nodes.length) throw new Error("Invalid or duplicate plan nodes");
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Cyclic dependency: " + id);
    if (visited.has(id)) return;
    const node = graph.get(id);
    if (!node) throw new Error("Unknown dependency: " + id);
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error("Duplicate dependency");
    visiting.add(id); node.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  nodes.forEach(node => visit(node.id));
}
