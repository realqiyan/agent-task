# Diagnose before changing anything

- **Command missing:** check the host's PATH and the user's known npm prefix. Use the existing absolute executable when available. If genuinely absent, follow [installation](installation.md) and obtain consent before executing npm.
- **Setup incomplete or wrong home:** use the home selected during setup. Do not expose the private environment file, run reset scripts or delete history. Interrupted initialization requires explicit approval for the CLI's resume procedure.
- **Host entry missing/duplicated:** inspect the host's MCP configuration and enabled plugin. Pi needs native registration; Claude/Codex normally use the bundled entry. Reconnect after setup, and preserve unrelated configuration. Custom home instructions are in [installation](installation.md).
- **No executor or adapters preparing:** use `executor_list` after connecting, or the existing CLI management commands when connection is unavailable. Explain missing native CLI, disabled executor, installation progress or preparation error separately. Use native login and authorization; never widen permissions to make a probe pass.
- **Custom ACP registration:** read [custom ACP registration](custom-acp.md). Check installed CLI support, the selected home, canonical executable path and native authorization. Registration needs no service restart; reconnect MCP only if its previous initialization failed. A ready registration is not an ACP protocol probe.
- **Connected but executable tasks rejected:** inspect `service_status` and the error, including coordinator configuration and executor readiness. Management access does not prove a usable model. Do not guess credentials or launch a task as an authentication probe.
- **Task failure, lost response or unknown outcome:** retrieve the existing task/run before proposing changes. Do not silently resubmit, change request keys or switch execution agents. Read [task usage](tasks.md) for the distinction between task and run controls.

Use `agent-task status` for the shared backend, with the same custom `--home` when selected. Host disconnection or plugin removal does not stop persisted tasks. Restarting can interrupt ACP sessions and waiting runs; inspect active work and obtain consent before `restart` or `stop`.

Logs and agent outputs can contain sensitive content. Do not print credential files or upload logs blindly. Report what was actually verified: configuration, connection, tool call, adapter readiness and real task delivery are separate evidence.
