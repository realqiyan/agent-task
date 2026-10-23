import { readManifest, runtimeBaseEnv } from "./install-lib.mjs";
import { launch } from "../dist/application/launcher.js";

process.umask(0o077);
const root = process.argv[2];
if (!root || process.argv.length !== 3) throw new Error("Expected installation home");
try {
  const manifest = readManifest(root);
  if (manifest.phase !== "ready") throw new Error("Installation is not ready; run agent-task setup --resume");
  await launch(root, runtimeBaseEnv(manifest));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
