import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("release admission rejects mismatched versions, branch pushes and commits outside master", t => {
  const root = mkdtempSync(join(tmpdir(), "task-conductor-release-")), repo = join(root, "repo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
  const version = "0.1.0-rc.2";
  const lock = { version, packages: { "": { version } } };
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "task-conductor", version }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify(lock));
  git("init", "--initial-branch=master");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  git("add", "package.json", "package-lock.json");
  git("commit", "-m", "Release fixture");
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  git("tag", "-a", "v" + version, "-m", "Release fixture");
  const output = join(root, "output");
  const check = (ref, event = "push", requested = "") => {
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [resolve("scripts/check-release.mjs")], {
      cwd: repo, env: { ...env, GITHUB_REF: ref, GITHUB_EVENT_NAME: event, REQUESTED_VERSION: requested, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    assert.ifError(result.error);
    return { status: result.status, output: readFileSync(output, "utf8") };
  };
  const accepted = { status: 0, output: "version=" + version + "\n" };
  assert.deepEqual(check("refs/tags/v" + version), accepted);
  assert.deepEqual(check("refs/heads/master", "workflow_dispatch", version), accepted);
  assert.deepEqual(check("refs/tags/v" + version, "workflow_dispatch", version), accepted);
  const rejected = result => { assert.notEqual(result.status, 0); assert.equal(result.output, ""); };
  rejected(check("refs/tags/v0.1.0-rc.3"));
  rejected(check("refs/heads/master"));
  rejected(check("refs/heads/master", "workflow_dispatch", "0.1.0-rc.3"));
  for (const invalid of [
    { ...lock, version: "0.1.0-rc.3" },
    { ...lock, packages: { "": { version: "0.1.0-rc.3" } } },
  ]) {
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify(invalid));
    rejected(check("refs/tags/v" + version));
  }
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify(lock));
  git("checkout", "-b", "unmerged");
  git("commit", "--allow-empty", "-m", "Not on master");
  rejected(check("refs/tags/v" + version));
});

test("registry install verification requires an explicit expected version before any install", () => {
  const env = { ...process.env };
  delete env.EXPECTED_VERSION;
  const result = spawnSync(process.execPath, [resolve("scripts/verify-install.mjs"), "--registry"], { env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXPECTED_VERSION is required/);
});
