import type { Settings } from "./settings.js";
import type { Tasks } from "./tasks.js";

/** Configuration preview and task impact are one management operation for all clients. */
export function previewSettings(settings: Settings, tasks: Pick<Tasks, "executorImpact">, input: unknown) {
  const preview = settings.preview(input);
  return { ...preview, affectedTasks: tasks.executorImpact(preview.config.executors) };
}
