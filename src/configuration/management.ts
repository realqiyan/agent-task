import type { ConfigEdit } from "./model.js";
import type { Settings } from "./settings.js";
import type { TaskDefinitions } from "../tasks/definitions.js";

/** Configuration preview and task impact are one management operation for all clients. */
export function previewSettings(settings: Settings, tasks: Pick<TaskDefinitions, "executorImpact">, input: ConfigEdit) {
  const preview = settings.preview(input);
  return { ...preview, affectedTasks: tasks.executorImpact(preview.config.disabledExecutors) };
}
