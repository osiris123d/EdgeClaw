import type { GitDiffResult, GitExecutionAdapter, GitRepoStatusSnapshot } from "./gitIntegrationTypes";

/** Default adapter: no live repo in Workers — formatting/export tools still operate on shared workspace text. */
export function createNoopGitExecutionAdapter(): GitExecutionAdapter {
  return {
    async getRepoStatus(): Promise<GitRepoStatusSnapshot> {
      return {
        mode: "unavailable",
        note:
          "Live git is not bound in this Worker. Attach a GitExecutionAdapter (e.g. MCP git tools, " +
          "remote repo service, or Workflow runner with checkout) for real status. " +
          "Use repo_git_export_* tools to produce git-friendly patch text from shared workspace proposals.",
      };
    },
    async getWorkingTreeDiff(): Promise<GitDiffResult> {
      return {
        error:
          "Working tree diff requires a GitExecutionAdapter with repository checkout access. " +
          "Export patches from shared workspace with repo_git_export_shared_patch instead.",
      };
    },
  };
}
