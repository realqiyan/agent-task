# Agent Task host integration

A dependency-free Pi package and Claude Code/Codex plugin. The plugin remains named `agent-task`; its skill is `using-agent-task`. It guides service installation, setup, MCP connection and daily task use. All task operations use the existing Agent Task MCP tools.

## Install before the service

Service and plugin sources share one Git repository, but ship as separate npm packages. Do not install `@realqiyan/agent-task` as a Pi plugin. This plugin is `@realqiyan/agent-task-plugin`.

After the plugin package and its matching marketplace entries are published:

```bash
pi install npm:@realqiyan/agent-task-plugin
# Or Claude Code: fetch only the marketplace index, then the npm plugin
claude plugin marketplace add https://raw.githubusercontent.com/realqiyan/agent-task/master/.claude-plugin/marketplace.json
claude plugin install agent-task@agent-task --scope user
# Or Codex: sparse-checkout the index, then fetch the npm plugin
codex plugin marketplace add realqiyan/agent-task --sparse .agents/plugins
codex plugin add agent-task@agent-task
```

The catalogs pin the reviewed npm plugin version. Their existence is not proof that the package has been published. Codex sparse checkout does not eliminate all Git metadata or root files.

For unpublished source, Pi can install the repository's `plugin/` directory directly. Claude/Codex developers can run `node scripts/create-plugin-marketplace.mjs` in the repository and register its output directory, then install `agent-task@agent-task-dev`. The snapshot has a local source and does not use npm. Do not enable development and release copies together.

There is no npm install hook or service dependency. This package does not silently run `npm install -g @realqiyan/agent-task`. In a new session, invoke:

- Pi: `/skill:using-agent-task`
- Claude Code: `/agent-task:using-agent-task`
- Codex: `$using-agent-task` or select it in `/skills`

The skill checks the installation and, with your confirmation, runs the service's npm install command using the host's shell tool. It then guides `agent-task setup`; credentials stay in your terminal/private files, not chat. Agent Task requires Linux/macOS, Node.js 22.19+ and npm. The host itself needs its own model access to follow the skill.

Pi registers MCP after setup. Claude Code/Codex declare MCP in the plugin; a missing-command/setup error is expected before initialization. Reconnect or start a new session after setup. Do not add a duplicate manual connection.

## Startup reminders

The Pi extension and Claude Code/Codex SessionStart hooks check installation state independently of MCP. When the check finds a problem, they show the skill entry point and supply brief model context. Healthy checks are silent; no model turn, installation, repair or service start is triggered.

The check runs `agent-task setup --check --json`, then `agent-task status --json` for valid configurations, within a shared time/output limit. The second query contacts only the existing local backend and compares installed, launcher and service versions; it never starts or restarts the backend. It does not interpret private files or forward child-process diagnostics. Missing version data and failed checks are inconclusive, not proof that installation is missing or versions match. This runs at session start, not continuously, and does not verify the host's MCP connection.

For a custom MCP command/home, set `AGENT_TASK_PREFLIGHT_COMMAND` and `AGENT_TASK_PREFLIGHT_HOME` in the environment that launches your host. They select only the check target; configure MCP separately with the same executable/home. Disable this hook/extension in the host if you do not want checks, or use a different connection.

Review and trust Codex's plugin hook in `/hooks` before expecting it to run. Disabled/untrusted hooks or a missing Node runtime cannot show the custom notice. Do not bypass hook trust. The skill remains available independently.

## Guides

- [Install, setup and connect](skills/using-agent-task/references/installation.md)
- [Submit tasks, inspect delivery and answer questions](skills/using-agent-task/references/tasks.md)
- [Troubleshoot](skills/using-agent-task/references/troubleshooting.md)
- [Full host installation and removal guide](https://github.com/realqiyan/agent-task/blob/master/docs/host-integrations.md)

Removing the plugin does not stop the shared service or delete task history. Pi's manually registered MCP entry must be removed separately. No plugin installation or skill grants executor tool permissions.
