/**
 * AI SDK tools: git-friendly formatting + optional live adapter (orchestrator-only for repo access).
 * Shared workspace bodies are read via SharedWorkspaceGateway — never embed git in KV backend.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { SharedWorkspaceGateway } from "../workspace/sharedWorkspaceTypes";
import type { GitExecutionAdapter, RepoGitToolPrincipalRole } from "./gitIntegrationTypes";
import {
  looksLikeUnifiedDiff,
  normalizeProposalToGitFriendlyPatch,
  suggestBranchName,
  suggestCommitMessageSubject,
  summarizeDiffText,
} from "./gitFriendlyPure";

const PROJECT_ID = z.string().min(1).max(128);

export interface GitIntegrationToolDeps {
  gateway: SharedWorkspaceGateway | null;
  adapter: GitExecutionAdapter;
}

export function isGitIntegrationToolsEnabled(env: {
  ENABLE_GIT_INTEGRATION_TOOLS?: string;
}): boolean {
  const v = env.ENABLE_GIT_INTEGRATION_TOOLS;
  if (v === undefined || v === "") {
    return true;
  }
  const lower = v.toLowerCase().trim();
  return lower !== "false" && lower !== "0" && lower !== "no";
}

export function createGitIntegrationToolSet(
  principalRole: RepoGitToolPrincipalRole,
  deps: GitIntegrationToolDeps
): ToolSet {
  const { gateway, adapter } = deps;

  const suggestBranch = tool({
    description:
      "Suggest a git branch name from task text (no repo access; does not create a branch). Use before handing off to human or MCP git.",
    inputSchema: z.object({
      taskSummary: z.string().min(1),
      projectId: PROJECT_ID,
    }),
    execute: async (args: { taskSummary: string; projectId: string }) => ({
      suggestedBranch: suggestBranchName(args.taskSummary, args.projectId),
    }),
  });

  const suggestCommit = tool({
    description:
      "Suggest a one-line conventional commit subject from a summary (no git commit; proposal only).",
    inputSchema: z.object({
      summary: z.string().min(1),
    }),
    execute: async (args: { summary: string }) => ({
      suggestedSubject: suggestCommitMessageSubject(args.summary),
    }),
  });

  const summarizeDiff = tool({
    description:
      "Summarize unified-diff text (truncate long patches). Safe read-only analysis for testers or orchestrator.",
    inputSchema: z.object({
      unifiedDiffText: z.string().min(1),
      maxLines: z.number().int().min(5).max(200).optional(),
    }),
    execute: async (args: { unifiedDiffText: string; maxLines?: number }) => ({
      summary: summarizeDiffText(args.unifiedDiffText, args.maxLines ?? 40),
    }),
  });

  const validatePatch = tool({
    description:
      "Heuristic validation only — checks whether text resembles a unified diff (does not guarantee git apply will succeed).",
    inputSchema: z.object({
      patchText: z.string().min(1),
    }),
    execute: async (args: { patchText: string }) => ({
      looksLikeUnifiedDiff: looksLikeUnifiedDiff(args.patchText),
    }),
  });

  const exportSharedPatch = tool({
    description:
      "Export a shared workspace patch proposal as git-friendly unified diff text (reads gateway; does not run git).",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      patchId: z.string().min(1).max(128),
      suggestedPathInRepo: z
        .string()
        .optional()
        .describe("Optional path hint for synthetic fragments e.g. src/foo.ts"),
    }),
    execute: async (args: {
      projectId: string;
      patchId: string;
      suggestedPathInRepo?: string;
    }) => {
      if (!gateway) {
        return {
          ok: false as const,
          error: "Shared workspace gateway unavailable (bind SHARED_WORKSPACE_KV).",
        };
      }
      const rec = await gateway.getPatchProposal(principalRole, args.projectId, args.patchId);
      if ("error" in rec) {
        return { ok: false as const, error: rec.error };
      }
      const body = rec.record.body;
      const pathHint = args.suggestedPathInRepo?.trim() || `proposal-${args.patchId}.patch`;
      const gitFriendly = normalizeProposalToGitFriendlyPatch(body, pathHint);
      return {
        ok: true as const,
        patchId: args.patchId,
        status: rec.record.status,
        gitFriendlyPatchText: gitFriendly,
      };
    },
  });

  const repoStatus = tool({
    description:
      "Live git repository status — requires GitExecutionAdapter (e.g. MCP). Returns unavailable in Workers by default.",
    inputSchema: z.object({
      cwdHint: z.string().optional(),
    }),
    execute: async (args: { cwdHint?: string }) => {
      if (!adapter.getRepoStatus) {
        return { mode: "unavailable" as const, note: "Adapter does not expose getRepoStatus." };
      }
      return adapter.getRepoStatus(args.cwdHint);
    },
  });

  const workingDiff = tool({
    description:
      "Working tree diff summary — requires GitExecutionAdapter with checkout access. Safe unavailable default.",
    inputSchema: z.object({
      maxBytes: z.number().int().min(1024).max(2_000_000).optional(),
    }),
    execute: async (args: { maxBytes?: number }) => {
      if (!adapter.getWorkingTreeDiff) {
        return { error: "Adapter does not expose getWorkingTreeDiff." };
      }
      const r = await adapter.getWorkingTreeDiff(args.maxBytes);
      if ("error" in r) {
        return r;
      }
      return {
        ...r,
        summary: summarizeDiffText(r.text, 40),
      };
    },
  });

  const exportPatchBundle = tool({
    description:
      "Orchestrator: export multiple shared workspace patch ids as one concatenated git-friendly text block for review/MCP.",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      patchIds: z.array(z.string().min(1).max(128)).min(1).max(20),
      suggestedPaths: z.array(z.string()).optional(),
    }),
    execute: async (args: {
      projectId: string;
      patchIds: string[];
      suggestedPaths?: string[];
    }) => {
      if (!gateway) {
        return { ok: false as const, error: "Shared workspace gateway unavailable." };
      }
      const blocks: string[] = [];
      for (let i = 0; i < args.patchIds.length; i++) {
        const pid = args.patchIds[i]!;
        const hint = args.suggestedPaths?.[i]?.trim() ?? `proposal-${pid}.patch`;
        const rec = await gateway.getPatchProposal(principalRole, args.projectId, pid);
        if ("error" in rec) {
          blocks.push(`# ERROR patch ${pid}: ${rec.error}`);
          continue;
        }
        blocks.push(
          `# --- patch ${pid} status=${rec.record.status} ---\n${normalizeProposalToGitFriendlyPatch(rec.record.body, hint)}`
        );
      }
      return { ok: true as const, bundleText: blocks.join("\n\n") };
    },
  });

  if (principalRole === "tester") {
    return {
      repo_git_summarize_diff: summarizeDiff,
      repo_git_validate_patch_text: validatePatch,
    };
  }

  if (principalRole === "coder") {
    return {
      repo_git_suggest_branch: suggestBranch,
      repo_git_suggest_commit_message: suggestCommit,
      repo_git_export_shared_patch: exportSharedPatch,
      repo_git_summarize_diff: summarizeDiff,
    };
  }

  // orchestrator
  return {
    repo_git_suggest_branch: suggestBranch,
    repo_git_suggest_commit_message: suggestCommit,
    repo_git_summarize_diff: summarizeDiff,
    repo_git_validate_patch_text: validatePatch,
    repo_git_export_shared_patch: exportSharedPatch,
    repo_git_export_patch_bundle: exportPatchBundle,
    repo_git_status: repoStatus,
    repo_git_working_diff_summary: workingDiff,
  };
}
