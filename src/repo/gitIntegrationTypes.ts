/**
 * Git + Wrangler integration — **outside** SharedWorkspaceStorage/KV.
 *
 * Architecture
 * ────────────
 * - **Shared workspace** (`SharedWorkspaceGateway`): collaboration + staging + patch *proposals* — not git history.
 * - **Git**: system of record for code history — accessed only through `GitExecutionAdapter` (MCP, remote service, or future Workflow worker with repo access).
 * - **Think workspace**: scratch only — never promoted to git by this layer.
 * - **MainAgent**: sole approval authority for anything that mutates production or performs deploy-class actions.
 *
 * Staging → git flow (backend-agnostic)
 * ─────────────────────────────────────
 * 1. Coder writes proposals in shared workspace (`staging/`, `shared_workspace_put_patch`).
 * 2. Pure helpers here format proposals as git-friendly unified diff text (export only).
 * 3. Optional `GitExecutionAdapter` applies changes on a machine/repo that **has** git — not inside KV.
 * 4. Wrangler preview/production deploy are **separate capabilities** gated by tier + orchestrator (`gitWranglerExtension.ts`).
 */

/** Injected capability — live git never assumed inside the Workers isolate. */
export interface GitRepoStatusSnapshot {
  mode: "live" | "unavailable";
  branch?: string;
  shortHead?: string;
  dirty?: boolean;
  /** Untracked / modified paths when live */
  pathsSample?: string[];
  note?: string;
}

export type GitDiffResult = { text: string; truncated?: boolean } | { error: string };

/**
 * Pluggable git execution — MCP git server, CI adapter, or Workflow-backed runner with checkout.
 * Default: noop (status/diff unavailable; formatting tools still work).
 */
export interface GitExecutionAdapter {
  getRepoStatus?(cwdHint?: string): Promise<GitRepoStatusSnapshot>;
  getWorkingTreeDiff?(maxBytes?: number): Promise<GitDiffResult>;
}

/** Roles mirrored from shared workspace — controls which AI SDK tools are registered. */
export type RepoGitToolPrincipalRole = "orchestrator" | "coder" | "tester";
