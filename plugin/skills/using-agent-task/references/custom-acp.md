# Connect a custom local ACP executor

Use the administrator CLI for registration, not a task MCP tool. Registration authorizes the service to launch local code. MCP callers can list ready executor IDs and assign them to tasks; they cannot register commands, credentials or endpoints. The Web console uses the same management service.

## Check the scope first

1. Ask for the intended local stdio ACP executable and its non-secret arguments. This is not an HTTP/WebSocket URL, an already-running remote server, or an MCP server. The service starts and owns an ACP process for each node session.
2. Check `agent-task executor --help`. Continue only if the installed service exposes `register` and `unregister`. The plugin and service install separately; a newer skill does not prove the service supports these commands. If unavailable, report the version limitation and ask before upgrading. Do not invent an MCP registration tool or edit private service storage.
3. Confirm the installation/home. Use the same `--home /absolute/private/agent-task` for every command when selected. Run `agent-task status`. Registration needs a running service with administrator access. If stopped, ask the user to run `agent-task start` in another terminal, or perform an explicitly approved start using the host's process facilities. No built-in executor is required for this management step.
4. Prepare the executable's native authentication and unattended tool authorization separately. Do not request credentials in chat, add them to arguments, or put executor credentials in the service's private environment file. ACP requests for additional permission are rejected.

The executable must speak ACP over stdin/stdout, with diagnostics on stderr. It must support the service's ACP version and normal initialize/session/prompt flow. Do not assume client-side terminals, arbitrary file access, interactive login or permission approval are available.

## Register after confirmation

Create a JSON file at a user-approved location, with private permissions and no secrets. Example only; substitute the real executable and its documented arguments:

```json
{
  "id": "my-acp",
  "command": "/absolute/canonical/path/to/my-acp",
  "args": ["--stdio"],
  "cwd": "/absolute/canonical/path/to/agent-runtime"
}
```

Use an existing canonical absolute executable path; resolve symlinks first without running the executable. Omit `--stdio` if the program does not require it (use `"args": []`). `cwd` is optional: when absent, the process starts in the task workspace. When set, it must be an existing, accessible canonical absolute directory. It sets only the process startup directory; ACP `session/new` still receives the task workspace. Relative script/config arguments can depend on this startup directory, so use absolute paths when needed. No shell expansion is performed. Built-in IDs and existing registrations cannot be overwritten.

Explain the exact executable, arguments, optional startup directory, native authorization and chosen service instance. Obtain confirmation, then execute through the host's shell tool:

```bash
agent-task executor register --file /absolute/private/my-acp.json --yes
agent-task executor show my-acp
```

`--yes` confirms only the approved registration; it does not widen native permissions. Registration validates the local executable and optional startup directory, and persists the launch before making it available. It does not start ACP, probe a model or submit a task. Arguments are stored as launch configuration, not as secrets.

**No service restart is needed.** Registration is visible immediately and survives later restarts in the same data directory. It does not interrupt existing sessions or rewrite task assignments. Changing the data directory does not copy registrations. The executable inherits the backend's filtered native environment, not the terminal's environment at registration time. To change that environment, obtain confirmation to stop the backend and start it from the intended native environment; a refresh or registration does not import new terminal variables.

## Verify and use

- Run `agent-task executor list` and confirm the intended ID is `ready`. This proves only local launch readiness, not ACP compatibility, model login or complete tool authorization.
- Call the host's actual MCP `executor_list({})`. If MCP previously failed because there was no executor, reconnect the host MCP connection; do not restart the service.
- Define tasks through the existing `task_create` schema and select this ID as the node's `executorId`. Read [task usage](tasks.md). Do not submit work merely to test registration.
- Real ACP/model acceptance requires a separately approved, bounded task. State unverified boundaries rather than reporting registration as successful execution.

## Remove or change a registration

There is no in-place overwrite. For a different launch, prefer a new ID and new, explicitly approved future tasks; do not switch existing or uncertain work to it. Keep binaries and scripts under the administrator's control: a fixed path is not a content-integrity guarantee or a sandbox.

After inspecting affected work and obtaining confirmation:

```bash
agent-task executor unregister my-acp --yes
```

Unregistration persists immediately without restart. It blocks future dispatch through that ID but does not terminate active processes, delete history or change existing task snapshots; later continuation may be rejected. Reusing the ID with a different command, arguments or `cwd` does not rebind old tasks. A lost response requires checking current state before another write. Never delete registration files, history or workspaces to repair uncertain state.
