import { inspectInstallation, onboardingNotice } from "./scripts/preflight.mjs";

export default function (pi) {
  let active;
  pi.on("session_start", async (_event, ctx) => {
    const controller = new AbortController();
    const pending = inspectInstallation({ cwd: ctx.cwd, signal: controller.signal });
    active = { controller, pending };
    const state = await pending;
    if (controller.signal.aborted) return;
    const notice = onboardingNotice(state, "pi");
    if (!notice) return;
    if (ctx.hasUI) ctx.ui.notify(notice.systemMessage, "warning");
    pi.sendMessage({
      customType: "agent-task-onboarding",
      content: notice.systemMessage + "\n" + notice.hookSpecificOutput.additionalContext,
      display: !ctx.hasUI,
      details: { state },
    }, { triggerTurn: false });
  });
  pi.on("session_shutdown", async () => {
    active?.controller.abort();
    await active?.pending;
    active = undefined;
  });
}
