import test from "node:test";
import assert from "node:assert/strict";
import { createExecution } from "../dist/integrations/acp/execution.js";
const openExecution = createExecution({ PATH: "/usr/bin:/bin" });
import { executorRecord } from "../dist/executors/validation.js";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { readTextFile } from "../dist/integrations/acp/connection.js";
import { Results } from "../dist/results/service.js";
import { LocalResultFiles } from "../dist/results/files.js";
import { NodeSessions } from "../dist/tasks/sessions.js";

test("ACP 文件请求错误允许纠正，已授权交付损坏仍终止会话", t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-acp-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const results = new Results(new LocalResultFiles(join(dir, "results"), true));
  const path = results.save("run", "node", "delivery", "first\nsecond\n");
  const controller = new AbortController();
  const request = { sessionId: "session", path };
  const read = params => readTextFile(results, [path], params, "session", controller);
  for (const params of [{ ...request, path: join(dir, "source.ts") }, { ...request, sessionId: "other" },
    { ...request, line: 0 }, { ...request, limit: 0 }]) {
    assert.throws(() => read(params), error => error instanceof RequestError && error.code === -32602);
    assert.equal(controller.signal.aborted, false);
  }
  assert.throws(() => readTextFile(results, [], request, "session", controller), RequestError);
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(read({ ...request, line: 2, limit: 1 }), { content: "second" });
  const secret = join(dir, "secret"); writeFileSync(secret, "private");
  rmSync(path); symlinkSync(secret, path);
  assert.throws(() => read(request), /authorized/);
  assert.equal(controller.signal.aborted, true);
  rmSync(path); writeFileSync(path, "restored");
  assert.throws(() => read(request), /authorized/);
  const missing = new AbortController(); rmSync(path);
  assert.throws(() => readTextFile(results, [path], request, "session", missing), /ENOENT/);
  assert.equal(missing.signal.aborted, true);
});

test("文件输入能力变化时回收真实 worker，已有能力的会话保留", { timeout: 10000 }, async t => {
  const sessions = new NodeSessions(openExecution, error => { throw error; });
  t.after(() => sessions.close());
  const executor = executorRecord.parse({ id: "exit", type: "codex", nativePath: "/usr/bin/false", command: "/usr/bin/false", args: [], adapterVersion: null });
  let starts = 0, disconnected = 0;
  const open = files => sessions.open("node", "run", { executor, workspace: "/tmp", inputFiles: files, resultsRoot: "/tmp/results" },
    60, () => {}, () => { starts++; }, () => assert.fail("会话计时器不应到期"), () => { disconnected++; });
  const empty = open([]);
  await Promise.all([sessions.retireWithoutInputFiles("node"), sessions.retireWithoutInputFiles("node")]);
  assert.equal(sessions.size, 0);
  await assert.rejects(empty.prompt("closed"), /closed/);
  const withFiles = open(["/tmp/results/run/node.delivery.txt"]);
  await sessions.retireWithoutInputFiles("node");
  assert.equal(sessions.get("node"), withFiles);
  await sessions.closeSession("node");
  assert.equal(starts, 0);
  assert.equal(disconnected, 0);
  assert.equal(sessions.size, 0);
});

test("closing a real worker before readiness is idempotent and never starts ACP", { timeout: 10000 }, async () => {
  const executor = executorRecord.parse({ id: "exit", type: "codex", nativePath: "/usr/bin/false", command: "/usr/bin/false", args: [], adapterVersion: null });
  let starts = 0, events = 0;
  const session = openExecution({ executor, workspace: "/tmp", inputFiles: [], resultsRoot: "/tmp/results" }, () => { events++; }, () => { starts++; });
  await Promise.all([session.close(), session.close()]);
  await assert.rejects(session.prompt("Must not start"), /closed/);
  assert.equal(starts, 0); assert.equal(events, 0);
});
