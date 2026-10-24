# Work through the existing MCP tools

Discover the host's Agent Task server, its instructions and current input/output schemas before calling tools. Use the actual host namespace. Do not implement a forwarding tool, copy full schemas into this skill, or replace MCP operations with direct database/file writes.

## Submit work

- Establish the user's goal, intended delivery, execution timing and existing absolute workspace. Ask for missing facts rather than guessing. The plugin/cache directory is not the task workspace; give an explicit workspace unless the stdio launch directory is known to be correct.
- Call `executor_list`. Select only existing ready executors appropriate for the user-authorized work. Adapter readiness alone does not establish native model login or tool permissions.
- As the MCP caller, define the complete DAG and executor assignment for each node to match the user's request. Make dependencies and each node's work/acceptance criteria explicit; use one node when sufficient. Clarify material ambiguity or consequential actions before submission. Do not ask the service coordinator to invent or change the plan.
- Read `task_create`'s current schema for timing, limits and request-key semantics. Keep the original submission identity and parameters when checking an uncertain response; do not create a fresh request key to replay work.
- Call `task_create` only for authorized work. Save/report the task ID and workspace. Submission confirms persistence, not successful execution.

## Inspect progress and delivery

Use `task_list` to locate tasks, `task_get` for definitions, `task_run_list` for run history and `task_run_get` for run details and accepted delivery. Follow pagination using the returned continuation value and unchanged filters; avoid rapid, unbounded polling.

Distinguish task trigger state from a particular run's outcome. Explain whether work is scheduled, executing, waiting for user facts, failed or delivered using the returned facts. A protocol turn ending or raw executor output is not accepted delivery. Read the accepted content and disclose missing evidence instead of treating a success label as proof of completeness.

## Answer questions

When a run needs user facts, retrieve its current unanswered question and applicable deadlines. Present the actual question and relevant completed work to the user. Submit their answer through `task_run_reply` using that run and question's identities and the tool's request-key contract.

Do not invent an answer, substitute your own assumptions, treat a fact reply as permission, or start a new task to bypass the wait. If a reply's outcome is uncertain, inspect the existing run before further writes.

## Control future work or cancel a run

Use `task_update` for future-trigger pause/resume/cancel, and `task_run_cancel` to stop a particular run. Confirm which scope the user intends; changing future triggers does not cancel the current run. Cancellation cannot undo external side effects.

For interrupted or unknown external outcomes, report the block and ask for investigation. Do not automatically retry, replay completed nodes, switch executors, edit the DAG or create replacement work to evade the block.

Service administration uses the existing `agent-task` CLI, not task MCP wrappers. Consult `agent-task --help` and the relevant subcommand help for settings, executor discovery and lifecycle actions. Ask before applying configuration, upgrading adapters or restarting a service with active work.
