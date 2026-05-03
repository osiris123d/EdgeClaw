# Agent orchestration boundaries

This document describes authority, storage, and failure boundaries for the parent (`MainAgent`) and delegated sub-agents (`CoderAgent`, `TesterAgent`). It complements inline comments in `sharedWorkspaceTypes.ts`, `codingLoopTypes.ts`, and `subagentToolSurface.ts`.

**Numbered flow (coder → KV → tester → approve/apply → promotion):** see [`coding-platform-architecture.md`](./coding-platform-architecture.md#coding-loop-vs-promotion-end-to-end) — *Coding loop vs promotion (end-to-end)*.

**Coding loop topology (canonical):** when `SUBAGENT_COORDINATOR` is bound, **`SubagentCoordinatorThink`** is the DO that runs `runCodingCollaborationLoop` and owns `subAgent(CoderAgent|TesterAgent)`; **MainAgent** reaches it via `stub.fetch` + JSON only. See [`coding-platform-architecture.md`](./coding-platform-architecture.md) §1 (sub-agent orchestration).

**Platform layers, adapter precedence (canonical vs transitional), migration steps, and workflow responsibilities:** see [`coding-platform-architecture.md`](./coding-platform-architecture.md).

## Authority boundaries

### Orchestrator-only APIs

Promotion (manifest preparation, artifact write), Flagship release gate, preview deploy, production deploy, and durable preview/production workflows are exposed as **instance methods on `MainAgent`**, not as AI tools. Each entry point calls `assertOrchestratorPromotionBoundary(this, MainAgent)` so subclasses (`CoderAgent`, `TesterAgent`, `ExecutionAgent`, `ResearchAgent`) **cannot invoke them at runtime** even though TypeScript still lists inherited methods.

There are **no** `build_promotion_*` / `deploy_*` tools on `getTools()`; sub-agents cannot schedule promotion via the model tool surface.

### Tool surface (`getTools()`)

`MainAgent.getTools()` adds orchestrator-scoped shared workspace + optional git integration tools only when `this.constructor === MainAgent`. Sub-agents override `getTools()` and merge **role-scoped** `createSharedWorkspaceToolSet(..., "coder" | "tester")` instead.

`CoderAgent` / `TesterAgent` apply `filterMainAgentToolSurface` to strip workflow and scheduled-task tools (`list_workflows`, `run_workflow`, `schedule_task`, `cancel_task`). Tester additionally strips project-note mutations.

### Hidden coupling (acceptable)

- `codingLoop/promotionFromCodingLoop.ts` imports `promotionOrchestration` to build an in-memory manifest candidate after a loop. It does **not** write artifacts or call the release gate. Only `MainAgent.derivePromotionCandidateFromCodingLoop` is wired in production; the module header documents orchestrator-only consumption.

## Storage boundaries

| Domain | Mechanism | Purpose |
|--------|-----------|---------|
| Think workspace | Per-DO SQLite (`@cloudflare/shell`) | Scratch, shell tools, optional code-exec `state.*` — not canonical shared code |
| Project notes | Tools under Think workspace tree | Same-DO structured notes — distinct from shared workspace |
| Shared workspace | `SharedWorkspaceStorage` (e.g. KV `SHARED_WORKSPACE_KV`) | Patch proposals, staging paths, verification blobs per `projectId` |
| Promotion artifacts | `PROMOTION_ARTIFACTS_BUCKET` or noop writer | Immutable promotion manifests — **not** collaboration KV |
| Skills | `SKILLS_BUCKET` | Session skills — unrelated to patches |
| Workflow persistence | DO / R2 workflow artifacts | Workflow runs — unrelated to patch handoff |
| Git lineage | `GitExecutionAdapter`, MCP, workflows | Canonical repo history — not KV snapshot |

## Failure boundaries

- **Coding loop terminal statuses** are enumerated in `CodingLoopTerminalStatus` (`codingLoopTypes.ts`): success, bounded-stop, abort, blocked workspace, repeated failure, etc.
- **Manager iteration decisions** (`ManagerIterationDecision`) provide an audit trail per iteration (revision, approval waits, guardrail stops).
- **Durable promotion/deploy** paths use Cloudflare Workflows with `step.do` checkpoints where implemented — retry-safe vs interactive `runApprovedPatchesPreviewPipeline`.

## Role × capability matrix

| Capability | MainAgent (orchestrator) | CoderAgent | TesterAgent | ExecutionAgent / ResearchAgent |
|------------|--------------------------|------------|-------------|-------------------------------|
| Think shell workspace tools (merged by Think) | Yes | Yes | Yes | Yes |
| Workflow tools (`list_workflows`, `run_workflow`) | Yes | Denied | Denied | Yes (not filtered) |
| Scheduled tasks (`schedule_task`, `cancel_task`) | Yes | Denied | Denied | Yes |
| Shared workspace (`shared_workspace_*`) | Yes (`orchestrator`) | Yes (`coder`) | Yes (`tester`) | No — only `MainAgent`/`CoderAgent`/`TesterAgent` merge gateway tools; Execution/Research use `super.getTools()` without adding shared workspace |
| Git integration (`repo_git_*`, noop adapter) | Yes (`orchestrator`, if enabled) | Yes (`coder`, if enabled) | Yes (`tester`, if enabled) | No — base merge is orchestrator-only; these subclasses do not add role-scoped git |
| Project note writes | Yes | Yes | Denied | Yes |
| **Coding loop (manager ↔ coder ↔ tester)** | **Yes** — issues `stub.fetch` to **`SubagentCoordinatorThink`** when `SUBAGENT_COORDINATOR` is bound; else runs loop in-process on MainAgent | **Child of coordinator only** (not MainAgent facet) | **Child of coordinator only** | N/A |
| Promotion / release gate / preview or prod deploy APIs | Yes (guarded) | Runtime block | Runtime block | Runtime block |

## High-value test gaps (optional follow-ups)

- **Done:** deny-list contract + filter regression — `src/agents/__tests__/subagentToolBoundary.test.ts`.
- **Done:** cross-seam `runPreviewPromotionPipeline` trace — `src/promotion/__tests__/previewPromotionCrossSeam.test.ts`.
- Delegated-session integration tests that RPC cannot bypass orchestrator-only methods (if new RPC surfaces appear).

Additional cross-cutting gaps (deploy seams, factories, Workflows): [`coding-platform-architecture.md`](./coding-platform-architecture.md) §8.
