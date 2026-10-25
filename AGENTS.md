# Repository Guidelines

Agent Task is an independently developed TypeScript service. MCP exposes task management; ACP connects execution agents. Pi Agent, Codex, Claude and OpenCode are ACP executor integration targets, not executors embedded in this service.

## Read first

- `docs/architecture-guidelines.md`: design and dependency requirements.
- `docs/design-proposal.md`: original requirements, overall design, decisions and deferred capabilities.
- `docs/technical-design.md`: code/test navigation, dependency boundaries and resource ownership.
- `docs/validation.md`: validation entry points, evidence and acceptance limits.
- `docs/deployment.md`: installation, authentication and service operation.
- `docs/web-console.md`: local administrator access, settings persistence and console limits.
- `README.md`: project entry and documentation navigation.

These documents are self-contained. Development does not require another project's checkout or the conversation that produced the requirements. The loopback Web console manages next-start configuration and reads tasks; its only task write operations control future triggers. Outbound ACP and inbound MCP have distinct roles.

## Structure and boundaries

Keep business rules in services, protocol contracts beside their tools, persistence in storage, and protocol/process behavior in integrations. Data models have no business behavior or SDK types. The application entry assembles dependencies and owns lifecycle. The Web console calls the same task services as MCP; keep HTML small and separate scripts and styles.

Use plain data and narrow capabilities. Services must not depend on MCP/ACP SDK contexts, HTTP objects, UI, or complete process objects. Storage executes transactions but does not own scheduling, authorization or recovery policy. No circular dependencies or hidden global mutable state.

Business capabilities live in tasks, executors, configuration and results. Protocol adapters, execution integrations, infrastructure and application assembly have separate owners. TaskRuns is the business write entry for Run state. Keep new responsibilities within these boundaries and update the dependency checker when adding a module. Do not add empty directories, unused interfaces, forwarding layers or a dynamic plugin platform.

`src/` contains TypeScript source and `src/web/` contains browser assets; `tests/` contains Node tests; `scripts/` contains operator/development helpers and future explicit upgrades. `dist/` is generated and must not be edited. Group files and tests by domain as the relevant layers grow.

## Runtime and safety

- MCP callers define the Task DAG and assign each node to a ready local ACP executor. Pi durable keeps one coordinator conversation per Task, with separately admitted Runs, to advance that fixed DAG, review results and request missing user facts; it does not decompose tasks or change the plan. ACP agents perform domain work. Reuse the SDK model loop; do not add another planner or parallel node scheduler.
- Ordinary messages do not answer pending questions or authorize idle ACP work. Supplementary work needs explicit intent; terminal Runs and accepted deliveries remain immutable. Documents and conversation history are advisory, not execution authority. See `docs/task-conversation-plan.md`.
- A protocol turn ending is not task completion. Only explicitly accepted executor deliveries can unlock dependencies. Unknown external outcomes block new dispatch, including fresh model-issued calls.
- Use official protocol SDKs and native execution-agent configuration where possible.
- Persist admission/dispatch intent before external work. Keep Task, Run, Session and external business records distinct.
- Do not automatically retry interrupted work, replay external side effects or switch agents after an uncertain outcome.
- Deadlines stop new starts; execution timeouts are separate. Client disconnection does not cancel persisted tasks.
- Resources have explicit ownership and idempotent close behavior. Reject operations against closed instances.
- Only discovered or locally administrator-registered, enabled local executors with prepared launch dependencies may launch. Custom registrations persist before admission and do not probe models. The service owns launch commands; MCP callers cannot supply commands, credentials or capability endpoints. Task creation selects an existing absolute workspace, resolved from the request or local MCP launch directory and fixed for future runs. Workspace validation is not authorization or a sandbox.
- Keep discovered capability facts, authorization and validation evidence separate.
- ACP permission requests are optional. Rely on native executor authorization and reject requests for additional ACP approval. Discovery and adapter readiness are not proof of complete tool authorization. Never infer permission from prompts, roles, tool titles or protocol success.
- No interactive approvals for unattended execution. Reject requests that lack sufficient authorization; never silently widen access.
- Executors inherit the OS user’s native environment only after filtering private service variables and credential aliases. Do not inherit service credentials into executors. Do not intentionally log secrets. Agent outputs may still be sensitive.
- Never delete user history or workspaces to repair state. Do not add file hash verification in code, tests or checks.

## Storage and releases

Use this project's package version. Do not copy another project's storage markers or bind releases to it.

Initialize new storage separately from upgrading existing data. Normal startup must not silently migrate or repair old data. Actual conversions belong in standalone scripts: declare supported formats, require a stopped service and exclusive ownership, back up first, validate after changes, and support explicit resumption. At the current research/MVP validation stage, no backward compatibility is required. The public abstraction is a Task with a caller-defined DAG of one or more nodes and a fixed ACP executor assignment per node. Use Task/task names for APIs, types, files and documentation. Single-node and multi-node tasks share one API and engine; do not retain separate single-node APIs, storage adapters or parallel schedulers. This does not authorize deleting user data. Do not add unused compatibility layers or extra version counters.

## Style and commands

Use TypeScript ESM, strict compiler checks, two-space indentation, double quotes, semicolons, .js relative import suffixes and import type for type-only imports. Use camelCase, PascalCase and kebab-case filenames.

Use macOS or Linux and Node.js 22.19+. Local SQLite locking replaces external flock.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: TypeScript and dependency-boundary checks.
- `npm run build`: compile to dist.
- `npm test`: build and run Node tests serially.
- `git diff --check`: whitespace validation.

`scripts/check-boundaries.mjs` checks dependency direction, cycles, SDK placement and the Run write entry. These checks do not prove runtime authorization or external side-effect safety.

## Tests and documentation

Use node:test and node:assert/strict with real local files, SQLite, processes and SDK behavior. At this research stage keep only basic, critical correctness and safety tests, not exhaustive suites. Test concrete risks, not coverage counts, implementation structure, documentation, prompt text or UI labels. Structured inputs and outputs may be tested as logic contracts.

Do not use mocks, stubs, fake models, simulated providers, personal credentials or real trades. Real agent/model acceptance needs an approved environment. A real failing process proves a failure path, not successful ACP execution. Keep unverified boundaries explicit.

Documentation is navigation first. Link to code for fields, defaults, schemas, state transitions and internal workflows; do not copy them into prose or tables. Keep product goals, design reasons, safety constraints, essential operator steps and validation evidence that code cannot establish. Give each topic one owner and link to it elsewhere.

Update documentation only when goals, usage, important constraints, key conclusions or navigation entry points materially change. Internal changes and repeated checks do not require documentation updates. Keep product goals, current implementation and validation evidence separate.

Validation records keep conclusions, applicable versions and conditions, unverified boundaries and necessary evidence links. Merge superseded evidence; retain older evidence only when it establishes a distinct conclusion or limitation. Do not append development, debugging, test or release execution logs, or move them into new history documents. Runtime instructions and skills are not history logs either. Use short, precise statements; preserve essential operator steps and safety constraints.

Run npm run check, npm test and git diff --check before submission. Use focused feat: or fix: commits when commits are requested. Keep credentials, runtime databases, generated files and local configuration out of Git.
