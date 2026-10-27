import test from "node:test";
import assert from "node:assert/strict";
import { permissionDecision } from "../dist/executors/permissions.js";
import { progressEvents } from "../dist/integrations/acp/connection.js";
import { executorEnvironment } from "../dist/executors/environment.js";
const request = {
  sessionId: "session", toolCall: { toolCallId: "tool", name: "read_file", rawInput: { path: "a" } },
  options: [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
};
test("unattended ACP requests never grant additional permissions", () => {
  assert.equal(permissionDecision(request).outcome.optionId, "no");
  assert.equal(permissionDecision({ ...request, toolCall: { title: "read_file" } }).outcome.optionId, "no");
  assert.deepEqual(permissionDecision(request, true), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(permissionDecision({ ...request, options: request.options.filter(o => o.kind.startsWith("allow")) }),
    { outcome: { outcome: "cancelled" } });
});
test("public progress preserves output and omits thoughts and raw tool data", () => {
  const text = "a".repeat(5000);
  const events = progressEvents({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  assert.equal(events.map(event => event.text).join(""), text);
  assert.ok(events.every(event => event.text.length <= 2000));
  assert.deepEqual(progressEvents({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private" } }), []);
  const tools = progressEvents({ sessionUpdate: "tool_call", toolCallId: "id", name: "read", title: "Read",
    rawInput: { secret: "private" }, rawOutput: "private", kind: "read", status: "completed" });
  assert.deepEqual(tools, [{ kind: "tool", data: { id: "id", name: "read", kind: "read", status: "completed" } }]);
});
test("native executor environment survives, but service secrets, coordinator credentials and aliases do not", () => {
  const privateValues = { SERVICE_AUTH: "service", TASK_CONDUCTOR_ADMIN_TOKEN: "administrator", MODEL_KEY: "coordinator", NEXT_MODEL_KEY: "next" };
  const config = { tokenEnv: "SERVICE_AUTH", coordinator: { provider: "openai-compatible", apiKeyEnv: "MODEL_KEY" } };
  const env = executorEnvironment({ PATH: "/usr/bin", HOME: "/work", XDG_CONFIG_HOME: "/native", CODEX_HOME: "/native/codex",
    NATIVE_API_KEY: "native", ...privateValues, ALIAS_KEY: "coordinator", PENDING_ALIAS: "next",
    NODE_OPTIONS: "--require arbitrary", PI_ACP_PI_COMMAND: "/unreviewed", TASK_CONDUCTOR_INTERNAL: "private" }, privateValues, config);
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/work", XDG_CONFIG_HOME: "/native", CODEX_HOME: "/native/codex", NATIVE_API_KEY: "native" });
});
