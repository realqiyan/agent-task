import { readManifest, runtimeBaseEnv } from "./install-lib.mjs";
import { launch } from "../dist/application/launcher.js";

process.umask(0o077);
const root = process.argv[2];
if (!root || process.argv.length !== 3) throw new Error("Expected installation home");
const manifest = readManifest(root);
if (manifest.phase !== "ready") throw new Error("Installation is not ready");
await launch(root, runtimeBaseEnv(manifest));
