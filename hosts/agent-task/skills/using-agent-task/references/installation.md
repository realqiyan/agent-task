# Install and connect Agent Task

The plugin can be installed before the service. Its read-only startup check can show a using-agent-task reminder even when MCP cannot start. This check does not grant installation permission or prove MCP health; do not treat an inconclusive check as proof the service is absent. Plugin installation itself has no npm install hook and does not initialize a service. Claude Code/Codex may report an unavailable bundled MCP server until installation and setup are complete; the skill remains usable.

## Check and install

1. Identify the host, OS, intended installation and configuration scope. Require Linux/macOS, Node.js 22.19+ and npm; check `node --version`, `npm --version`, `command -v agent-task` and, when found, `agent-task --version`. Do not infer the task workspace from the plugin directory.
2. Check whether this is an existing installation, a custom `--home`, or an already configured MCP connection. If the command is not on PATH, first check the user's known installation and `npm prefix -g`; a PATH problem does not require a second install.
3. If the service is absent, explain that installation downloads a global npm package into the current user's npm prefix. Ask for confirmation to install `@realqiyan/agent-task`. Use an explicitly requested version when supplied; do not invent a version or imply the integration bundle version is already published.
4. After confirmation, **execute** `npm install -g @realqiyan/agent-task` with the host's shell tool and normal permission checks. Do not use sudo, change the user's npm prefix or relax host security automatically. If permission or network access is unavailable, report the failure and offer the same command for the user's terminal. Do not retry with broader access.
5. Check the exit status and installed `agent-task --version`. If necessary, locate the executable under the confirmed prefix's `bin/` and use its absolute path. Keep an existing installation unchanged unless the user explicitly approves an upgrade.

Do not run installation in an MCP command, session-start hook, or `npx -y` launcher. Reconnection must not install or upgrade the service. Do not silently fall back from a failed release install to source builds.

## Initialize through the existing CLI

Ask the user to run `agent-task setup` in their own terminal, or `agent-task setup --home /absolute/private/agent-task` for the chosen custom home. Let them confirm directories, port, independent service/admin tokens and coordinator provider/model in that wizard. Do not request secret values in chat, print credential files, or reuse the host's model login as coordinator credentials.

For a user-requested noninteractive setup, read `agent-task setup --help` and use only explicitly confirmed options and a user-prepared private credentials file. You may execute that command after confirmation. Do not invent model settings, generate tokens without consent or put secret values in arguments. Without a configured coordinator, management can work but executable tasks cannot be accepted.

Preserve existing setup. Interrupted initialization needs an explicitly approved `--resume`; do not delete history or guess repairs. At least one native pi, codex, claude or opencode CLI must be visible to the service, with its own native login and authorization. Explain before connecting that MCP initialization may download missing ACP adapters. Readiness is not proof of authentication or complete tool authorization.

## Startup-check scope and trust

The plugin checks `agent-task setup --check --json`, with bounded time/output and no automatic repair. Unsupported or failed checks are inconclusive. An initialized but stopped backend is not a missing installation.

Check the user's selected command/home before acting on a notice. When configuring a custom MCP connection, also set `AGENT_TASK_PREFLIGHT_COMMAND` and `AGENT_TASK_PREFLIGHT_HOME` in the host launch environment after confirmation. These non-secret variables select only the diagnostic target, not MCP or the service. Do not write them into service credentials or assume the plugin inferred manual host configuration.

Codex needs the user to review and trust the plugin hook in `/hooks`. Never bypass hook trust. If hooks/extensions are disabled or Node itself cannot start, use the explicit skill entry; lack of a notice does not establish readiness. The user can disable the check in the host while retaining the skill.

## Register or reconnect

Use the same OS user, native environment and home as setup. Stdio reads service credentials privately; do not copy token values or ports into host configuration. Inspect existing entries before adding or replacing one, preserve unrelated settings and keep only one Agent Task connection.

### Pi 1.4.0+ native MCP

After confirmation, execute:

```bash
pi mcp add agent-task -- agent-task mcp
pi mcp list
```

For a custom installation, replace the add command with:

```bash
pi mcp add agent-task -- /absolute/bin/agent-task mcp --home /absolute/private/agent-task
```

These are user-level entries; use `--local` only if the user chooses project scope. `add` replaces an existing same-name entry. Reload with `/reload` or start a new session. If another extension replaces Pi's native MCP, ask the user which integration to keep instead of installing a second bridge.

### Claude Code and Codex plugins

The enabled plugin already declares `agent-task mcp`. Do not also add a manual connection for the default installation. Complete setup, then start a new session; Claude Code also allows reconnecting the plugin server in `/mcp`. Inspect `/mcp` in the new session.

For a custom home or executable, keep the skill but disable the bundled MCP entry before registering a manual connection. Do not edit an update-managed plugin cache.

- Claude Code: ask the user to disable the plugin's Agent Task server in `/mcp`, then, with confirmation, execute:

```bash
claude mcp add --transport stdio --scope user agent-task -- /absolute/bin/agent-task mcp --home /absolute/private/agent-task
```

- Codex: with confirmation, merge this single table into the user's config without replacing other settings, then register the manual connection:

```toml
[plugins."agent-task@agent-task".mcp_servers.agent-task]
enabled = false
```

```bash
codex mcp add agent-task -- /absolute/bin/agent-task mcp --home /absolute/private/agent-task
```

Restart the session and confirm only the intended connection is enabled. GUI hosts must also be able to find Node and the native execution CLI.

## Verify without executing domain work

1. Confirm the host reports a connected server and lists its existing tools. A static configuration listing alone is not evidence of connection.
2. Discover and call `executor_list` and `task_list` with `{}` through the host's MCP interface. Pi uses native tool search/codemode by default. Use the actual server/tool namespace.
3. Report connection and read-only call results separately from executor readiness. If adapters are preparing, inspect later; do not submit a task or invoke a paid model merely to test installation.

Append the selected `--home` to later service CLI commands. `agent-task mcp` starts or reuses a shared background service; host exit does not stop it. Confirm before stopping or restarting active work.
