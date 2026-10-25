---
name: using-agent-task
description: Use Agent Task from Pi, Claude Code or Codex. Covers installing the service, setup and MCP connection, submitting caller-defined task DAGs, inspecting runs and deliveries, answering user-fact questions, registering custom local stdio ACP executors through the administrator CLI, and diagnosing connection failures.
---

# Using Agent Task

Use this skill when the user wants to use or connect Agent Task. It is guidance for the existing CLI and MCP tools, not a task executor, planner, scheduler or separate task API.

## Choose the next step

- **First use, missing service, or setup/connection request:** read [installation](references/installation.md). With user confirmation, execute the npm installation through the host's shell tool; do not merely suggest the command when you can perform the approved operation. Credentials stay in the user's terminal or private files.
- **Custom ACP executor request:** read [custom ACP registration](references/custom-acp.md). Use the administrator CLI after confirmation; registration applies without a service restart. Do not expose launch commands through task MCP tools.
- **Connected and ready to work:** read [task usage](references/tasks.md). Discover the host's actual MCP tools and their current schemas. Do not run setup or reinstall the service on every task request.
- **Connection or execution problem:** read [troubleshooting](references/troubleshooting.md). Inspect before changing anything; an uncertain outcome is not permission to replay work.

Resolve reference paths from this skill directory. These files ship inside the plugin, so onboarding does not require the service package or repository documentation.

## Boundaries

- MCP callers define the fixed DAG and assign an existing ready ACP executor to each node. The service coordinator advances that DAG; it does not decompose the goal or change the plan.
- Use existing MCP tools directly. Learn fields, defaults and errors from their live schemas, not a copied contract or a new wrapper.
- Installation, native login, adapter readiness and tool authorization are different facts. Never disable sandboxing or widen approvals to make an operation work.
- Keep credentials out of chat, command arguments and host MCP configuration. Do not read private environment files into model context.
- A completed protocol turn or successful task submission is not a completed task. Report accepted delivery, failure and waiting-for-user states distinctly.
- No automatic retries of interrupted work, executor switching, history deletion or workspace cleanup to repair state.

Explicit invocation: Pi `/skill:using-agent-task`; Claude Code `/agent-task:using-agent-task`; Codex `$using-agent-task` or select it in `/skills`.
