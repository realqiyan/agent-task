import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("SQLite loads quietly while other runtime warnings remain visible", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const original = process.emitWarning;
    const { DatabaseSync } = await import("./dist/sqlite.js");
    assert.equal(process.emitWarning, original);
    const db = new DatabaseSync(":memory:");
    assert.equal(db.prepare("SELECT 1 AS value").get().value, 1);
    db.close();
    process.emitWarning("unrelated experimental notice", "ExperimentalWarning");
    process.emitWarning("unrelated runtime notice");
  `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stderr.includes("SQLite is an experimental feature"));
  assert.match(result.stderr, /ExperimentalWarning: unrelated experimental notice/);
  assert.match(result.stderr, /Warning: unrelated runtime notice/);
});
