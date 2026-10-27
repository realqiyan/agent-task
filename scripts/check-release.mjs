// Release admission only: no credentials, package upload or external work.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref = "", REQUESTED_VERSION: requested, GITHUB_OUTPUT: output } = process.env;
const tagged = ref.startsWith("refs/tags/v");

assert(["push", "workflow_dispatch"].includes(event), "Unsupported release event");
assert(tagged || (event === "workflow_dispatch" && ref === "refs/heads/master"), "Release requires a version tag or manual master dispatch");
assert.equal(pkg.name, "task-conductor");
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
assert.equal(lock.version, pkg.version, "Lockfile version differs");
assert.equal(lock.packages[""].version, pkg.version, "Root package lock version differs");
if (tagged) assert.equal(ref, "refs/tags/v" + pkg.version, "Tag must match package version");
if (event === "workflow_dispatch") assert.equal(requested, pkg.version, "Requested version must match package version");

const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/master"], { encoding: "utf8" });
assert(!ancestry.error && ancestry.status === 0, "Release commit must belong to origin/master");
assert(output, "GITHUB_OUTPUT is required");
appendFileSync(output, "version=" + pkg.version + "\n");
console.log("Release admitted: " + pkg.version + " from " + ref);
