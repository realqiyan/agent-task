# Repository Guidelines

Agent Task is an independently developed TypeScript service. MCP exposes task management; ACP connects execution agents. Pi Agent, Codex and OpenCode are ACP executor integration targets, not executors embedded in this service.

## Read first

- `docs/architecture-guidelines.md`: design and dependency requirements.
- `docs/design-proposal.md`: original requirements, overall design, decisions and deferred capabilities.
- `docs/technical-design.md`: current implementation and known architectural gaps.
- `docs/validation.md`: evidence and acceptance limits.
- `README.md`: installation, configuration and operation.

These documents are self-contained. Development does not require another project's checkout or the conversation that produced the requirements. The HTTP management page remains a product goal, but the first release has no page. Outbound ACP and inbound MCP have distinct roles.

## Structure and boundaries

Keep business rules in services, protocol contracts beside their tools, persistence in storage, and protocol/process behavior in integrations. Data models have no business behavior or SDK types. The application entry assembles dependencies and owns lifecycle. Future UI calls the same services as MCP.

Use plain data and narrow capabilities. Services must not depend on MCP/ACP SDK contexts, HTTP objects, UI, or complete process objects. Storage executes transactions but does not own scheduling, authorization or recovery policy. No circular dependencies or hidden global mutable state.

The current MVP uses flat source files and has documented boundary gaps. Do not present it as already conforming to the target layers. When extending an affected responsibility, move that responsibility to its owner with behavior-preserving tests. Do not add empty directories, unused interfaces, forwarding layers or a dynamic plugin platform.

`src/` contains TypeScript source; `tests/` contains Node tests; `scripts/` contains operator/development helpers and future explicit upgrades; `deploy/` contains deployment templates. `dist/` is generated and must not be edited. Group files and tests by domain as the relevant layers grow.

## Runtime and safety

- Pi durable runs one coordinator conversation per TaskRun. The coordinator plans and reviews; ACP agents perform domain work. Reuse the SDK model loop; do not add another planner or parallel node scheduler.
- A protocol turn ending is not task completion. Only explicitly accepted executor deliveries can unlock dependencies. Unknown external outcomes block new dispatch, including fresh model-issued calls.
- Use official protocol SDKs and native execution-agent configuration where possible.
- Persist admission/dispatch intent before external work. Keep Task, Run, Session and external business records distinct.
- Do not automatically retry interrupted work, replay external side effects or switch agents after an uncertain outcome.
- Deadlines stop new starts; execution timeouts are separate. Client disconnection does not cancel persisted tasks.
- Resources have explicit ownership and idempotent close behavior. Reject operations against closed instances.
- Only administrator-registered executors may launch. MCP requests cannot supply arbitrary commands, directories, credentials or capability endpoints.
- Keep discovered capability facts, authorization and validation evidence separate.
- ACP permission requests are optional. The permission allowlist and unattendedApproved flag are not a sandbox or proof of complete tool authorization. Never infer permission from prompts, roles, tool titles or protocol success.
- No interactive approvals for unattended execution. Reject requests that lack sufficient authorization; never silently widen access.
- Do not inherit service credentials into executors. Do not intentionally log secrets. Agent outputs may still be sensitive.
- Never delete user history or workspaces to repair state. Do not add file hash verification in code, tests or checks.

## Storage and releases

Use this project's package version. Do not copy another project's storage markers or bind releases to it.

Initialize new storage separately from upgrading existing data. Normal startup must not silently migrate or repair old data. Actual conversions belong in standalone scripts: declare supported formats, require a stopped service and exclusive ownership, back up first, validate after changes, and support explicit resumption. At the current research/MVP validation stage, no backward compatibility is required. The public abstraction is an intelligent Task whose coordinator commits a DAG of one or more nodes. Use Task/task names for APIs, types, files and documentation. Single-node and multi-node tasks share one API and engine; do not retain separate single-node APIs, storage adapters or parallel schedulers. This does not authorize deleting user data. Do not add unused compatibility layers or extra version counters.

## Style and commands

Use TypeScript ESM, strict compiler checks, two-space indentation, double quotes, semicolons, .js relative import suffixes and import type for type-only imports. Use camelCase, PascalCase and kebab-case filenames.

Use Linux, Node.js 22.19+ and util-linux flock.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: TypeScript check; currently no dependency-boundary checker.
- `npm run build`: compile to dist.
- `npm test`: build and run Node tests serially.
- `git diff --check`: whitespace validation.

Add dependency-boundary checking when the documented layers are implemented; do not claim it exists beforehand.

## Tests and documentation

Use node:test and node:assert/strict with real local files, SQLite, processes and SDK behavior. At this research stage keep only basic, critical correctness and safety tests, not exhaustive suites. Test concrete risks, not coverage counts, implementation structure, documentation, prompt text or UI labels. Structured inputs and outputs may be tested as logic contracts.

Do not use mocks, stubs, fake models, simulated providers, personal credentials or real trades. Real agent/model acceptance needs an approved environment. A real failing process proves a failure path, not successful ACP execution. Keep unverified boundaries explicit.

Update the relevant documents when usage, business behavior, interfaces or architecture boundaries change; not for every internal or cosmetic change. Keep product goals, current implementation and validation evidence separate. Runtime instructions and skills are not development-history logs. Use short, precise statements; preserve conditions and limitations.

Run npm run check, npm test and git diff --check before submission. Use focused feat: or fix: commits when commits are requested. Keep credentials, runtime databases, generated files and local configuration out of Git.
