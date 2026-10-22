// Same process as the service: the service manager supervises the actual HTTP owner.
import { join } from "node:path";
import { readManifest, runtimeBaseEnv } from "./install-lib.mjs";

process.umask(0o077);
const root = process.argv[2];
if (!root || process.argv.length !== 3) throw new Error("Expected installation home");
const manifest = readManifest(root);
if (manifest.phase !== "ready") throw new Error("Installation is not ready");
const env = runtimeBaseEnv(manifest);
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
process.argv = [process.execPath, join(root, "app/dist/main.js"), "--config", join(root, "config.json"), "--environment", join(root, "environment.json")];
await import("../dist/main.js");
