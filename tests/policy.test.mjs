import test from "node:test";
import assert from "node:assert/strict";
import { permissionDecision } from "../dist/permissions.js";
import { progressEvents } from "../dist/acp.js";
import { executorEnv } from "../dist/config.js";
const request = {
  sessionId: "session", toolCall: { toolCallId: "tool", name: "read_file", rawInput: { path: "a" } },
  options: [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
};
test("permission policy is exact, rejects missing metadata and never grants always", () => {
  assert.equal(permissionDecision(request, []).outcome.optionId, "no");
  assert.equal(permissionDecision(request, ["read_*"]).outcome.optionId, "no");
  assert.equal(permissionDecision(request, ["read_file"]).outcome.optionId, "once");
  assert.equal(permissionDecision({ ...request, toolCall: { toolCallId: "tool", title: "read_file" } }, ["read_file"]).outcome.optionId, "no");
  assert.deepEqual(permissionDecision(request, ["read_file"], true), { outcome: { outcome: "cancelled" } });
  assert.equal(permissionDecision({ ...request, toolCall: { ...request.toolCall, rawInput: null } }, ["read_file"]).outcome.optionId, "no");
  assert.deepEqual(permissionDecision({ ...request, options: request.options.filter(o => o.kind === "allow_always") }, ["read_file"]),
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
test("executor environment excludes unselected credentials and service configuration", () => {
  const env = executorEnv(["HOME", "MODEL_KEY"], { PATH: "/usr/bin", HOME: "/work", MODEL_KEY: "selected",
    AGENT_TASK_TOKEN: "private", OTHER_KEY: "private", NODE_OPTIONS: "--require arbitrary" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/work", MODEL_KEY: "selected" });
});
