import { inspectInstallation, onboardingNotice } from "./preflight.mjs";

// Hook stdout is host JSON, not MCP stdout. Never echo hook input or child output.
process.stdin.resume();
process.stdin.unref?.();
try {
  const notice = onboardingNotice(await inspectInstallation(), process.argv[2]);
  if (notice) console.log(JSON.stringify(notice));
} catch {
  const notice = onboardingNotice("check-failed", process.argv[2]);
  if (notice) console.log(JSON.stringify(notice));
}
// A diagnostic must not block the host session or grant any tool permissions.
