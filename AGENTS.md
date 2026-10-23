# Repository Guidelines

Agent Task is an independently developed TypeScript service. MCP exposes task management; ACP connects execution agents. Pi Agent, Codex, Claude and OpenCode are ACP executor integration targets, not executors embedded in this service.

## Read first

- `docs/architecture-guidelines.md`: design and dependency requirements.
- `docs/design-proposal.md`: original requirements, overall design, decisions and deferred capabilities.
- `docs/technical-design.md`: code/test navigation and known architectural gaps.
- `docs/validation.md`: validation entry points, evidence and acceptance limits.
- `docs/deployment.md`: installation, authentication and service operation.
- `docs/web-console.md`: local administrator access, settings persistence and console limits.
- `README.md`: project entry and documentation navigation.

These documents are self-contained. Development does not require another project's checkout or the conversation that produced the requirements. The loopback Web console manages next-start configuration and reads tasks; its only task write operations control future triggers. Outbound ACP and inbound MCP have distinct roles.

## Structure and boundaries

Keep business rules in services, protocol contracts beside their tools, persistence in storage, and protocol/process behavior in integrations. Data models have no business behavior or SDK types. The application entry assembles dependencies and owns lifecycle. The Web console calls the same task services as MCP; keep HTML small and separate scripts and styles.

Use plain data and narrow capabilities. Services must not depend on MCP/ACP SDK contexts, HTTP objects, UI, or complete process objects. Storage executes transactions but does not own scheduling, authorization or recovery policy. No circular dependencies or hidden global mutable state.

The current MVP uses flat source files and has documented boundary gaps. Do not present it as already conforming to the target layers. When extending an affected responsibility, move that responsibility to its owner with behavior-preserving tests. Do not add empty directories, unused interfaces, forwarding layers or a dynamic plugin platform.

`src/` contains TypeScript source and `src/web/` contains browser assets; `tests/` contains Node tests; `scripts/` contains operator/development helpers and future explicit upgrades. `dist/` is generated and must not be edited. Group files and tests by domain as the relevant layers grow.

## Runtime and safety

- MCP callers define the Task DAG and assign each node to a registered ACP executor. Pi durable runs one coordinator conversation per TaskRun to advance that fixed DAG, review results and request missing user facts; it does not decompose tasks or change the plan. ACP agents perform domain work. Reuse the SDK model loop; do not add another planner or parallel node scheduler.
- A protocol turn ending is not task completion. Only explicitly accepted executor deliveries can unlock dependencies. Unknown external outcomes block new dispatch, including fresh model-issued calls.
- Use official protocol SDKs and native execution-agent configuration where possible.
- Persist admission/dispatch intent before external work. Keep Task, Run, Session and external business records distinct.
- Do not automatically retry interrupted work, replay external side effects or switch agents after an uncertain outcome.
- Deadlines stop new starts; execution timeouts are separate. Client disconnection does not cancel persisted tasks.
- Resources have explicit ownership and idempotent close behavior. Reject operations against closed instances.
- Only administrator-registered executors may launch. MCP task creation may select an existing absolute workspace; commands, credentials and capability endpoints remain administrator-only. Workspace validation is not authorization or a sandbox.
- Keep discovered capability facts, authorization and validation evidence separate.
- ACP permission requests are optional. Rely on native executor authorization and reject requests for additional ACP approval. The unattendedApproved flag is not a sandbox or proof of complete tool authorization. Never infer permission from prompts, roles, tool titles or protocol success.
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
- `npm run check`: TypeScript check; currently no dependency-boundary checker.
- `npm run build`: compile to dist.
- `npm test`: build and run Node tests serially.
- `git diff --check`: whitespace validation.

Add dependency-boundary checking when the documented layers are implemented; do not claim it exists beforehand.

## Tests and documentation

Use node:test and node:assert/strict with real local files, SQLite, processes and SDK behavior. At this research stage keep only basic, critical correctness and safety tests, not exhaustive suites. Test concrete risks, not coverage counts, implementation structure, documentation, prompt text or UI labels. Structured inputs and outputs may be tested as logic contracts.

Do not use mocks, stubs, fake models, simulated providers, personal credentials or real trades. Real agent/model acceptance needs an approved environment. A real failing process proves a failure path, not successful ACP execution. Keep unverified boundaries explicit.

Documentation is navigation first. Link to code for fields, defaults, schemas, state transitions and internal workflows; do not copy them into prose or tables. Keep product goals, design reasons, safety constraints, essential operator steps and validation evidence that code cannot establish. Give each topic one owner and link to it elsewhere.

Update the relevant navigation when entry points change, and requirements or evidence when their meaning changes; not for every internal or cosmetic change. Keep product goals, current implementation and validation evidence separate. Runtime instructions and skills are not development-history logs. Use short, precise statements; preserve conditions and limitations.

Run npm run check, npm test and git diff --check before submission. Use focused feat: or fix: commits when commits are requested. Keep credentials, runtime databases, generated files and local configuration out of Git.
