/**
 * AI SDK tools for SharedWorkspaceGateway.
 *
 * Role is fixed by which agent registers these tools — not chosen by the model.
 * Bind `SHARED_WORKSPACE_KV` only to attach the KV adapter; the contract is `SharedWorkspaceStorage`.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { SharedWorkspaceGateway } from "./sharedWorkspaceTypes";
import type { SharedWorkspacePrincipalRole } from "./sharedWorkspaceTypes";
import { SHARED_WORKSPACE_STAGING_PREFIX } from "./sharedWorkspaceTypes";

const PROJECT_ID = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "Logical project id agreed with the orchestrator (must match the delegation envelope when delegating)."
  );

function unconfiguredToolSet(): ToolSet {
  return {
    shared_workspace_unavailable: tool({
      description:
        "Shared workspace is not configured (missing SHARED_WORKSPACE_KV binding). " +
        "Ask the deployment owner to add a KV namespace binding named SHARED_WORKSPACE_KV.",
      inputSchema: z.object({}),
      execute: async () => ({
        ok: false as const,
        error:
          "Shared workspace storage binding is not configured. See wrangler comment for SHARED_WORKSPACE_KV.",
      }),
    }),
  };
}

export function createSharedWorkspaceToolSet(
  gateway: SharedWorkspaceGateway | null,
  principalRole: SharedWorkspacePrincipalRole
): ToolSet {
  if (!gateway) {
    return unconfiguredToolSet();
  }

  const readTool = tool({
    description:
      "Read a text file from the shared project workspace (not Think shell, not project-notes). Requires projectId.",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      path: z.string().min(1).describe("Relative path in the shared project tree."),
    }),
    execute: async ({ projectId, path }: { projectId: string; path: string }) => {
      return gateway.readFile(principalRole, projectId, path);
    },
  });

  const listTool = tool({
    description: "List file paths under a prefix in the shared project workspace.",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      prefix: z.string().describe("Directory prefix; use empty string for all files."),
    }),
    execute: async ({ projectId, prefix }: { projectId: string; prefix: string }) => {
      return gateway.listFiles(principalRole, projectId, prefix);
    },
  });

  const base: ToolSet = {
    shared_workspace_read: readTool,
    shared_workspace_list: listTool,
  };

  if (principalRole === "tester") {
    return {
      ...base,
      shared_workspace_list_patches: tool({
        description:
          "List patch proposals with status (read-only). Use with get_patch to review coder proposals before recording verification.",
        inputSchema: z.object({ projectId: PROJECT_ID }),
        execute: async ({ projectId }: { projectId: string }) => {
          return gateway.listPatchProposals(principalRole, projectId);
        },
      }),
      shared_workspace_get_patch: tool({
        description: "Read a patch proposal record including body (read-only verification).",
        inputSchema: z.object({
          projectId: PROJECT_ID,
          patchId: z.string().min(1).max(128),
        }),
        execute: async ({ projectId, patchId }: { projectId: string; patchId: string }) => {
          return gateway.getPatchProposal(principalRole, projectId, patchId);
        },
      }),
      shared_workspace_record_verification: tool({
        description:
          "Write a verification / test report for this project (isolated verification namespace — not arbitrary project file writes).",
        inputSchema: z.object({
          projectId: PROJECT_ID,
          verificationId: z.string().min(1).max(128),
          payload: z.string().min(1).describe("Structured report text (logs, pass/fail, notes)."),
        }),
        execute: async (args: {
          projectId: string;
          verificationId: string;
          payload: string;
        }) => {
          return gateway.recordVerification(principalRole, args.projectId, args.verificationId, args.payload);
        },
      }),
    };
  }

  if (principalRole === "coder") {
    const stagingPath = z
      .string()
      .min(1)
      .refine(
        (p) =>
          p === SHARED_WORKSPACE_STAGING_PREFIX || p.startsWith(`${SHARED_WORKSPACE_STAGING_PREFIX}/`),
        { message: `Path must be '${SHARED_WORKSPACE_STAGING_PREFIX}' or '${SHARED_WORKSPACE_STAGING_PREFIX}/…'` }
      );

    const listPatchesReadOnly = tool({
      description: "List patch proposals with status (read-only).",
      inputSchema: z.object({ projectId: PROJECT_ID }),
      execute: async ({ projectId }: { projectId: string }) => {
        return gateway.listPatchProposals(principalRole, projectId);
      },
    });

    return {
      ...base,
      shared_workspace_list_patches: listPatchesReadOnly,
      shared_workspace_write_staging: tool({
        description:
          `Write text only under the '${SHARED_WORKSPACE_STAGING_PREFIX}/' prefix — staging handoff before orchestrator approval. Cannot write canonical project paths.`,
        inputSchema: z.object({
          projectId: PROJECT_ID,
          path: stagingPath.describe(`Must start with ${SHARED_WORKSPACE_STAGING_PREFIX}/`),
          content: z.string(),
        }),
        execute: async (args: { projectId: string; path: string; content: string }) => {
          return gateway.writeFile(principalRole, args.projectId, args.path, args.content);
        },
      }),
      shared_workspace_put_patch: tool({
        description:
          "Propose a patch (pending). Orchestrator approves/rejects/applies. Overwrites only while status is pending.",
        inputSchema: z.object({
          projectId: PROJECT_ID,
          patchId: z.string().min(1).max(128),
          body: z.string().min(1),
        }),
        execute: async (args: { projectId: string; patchId: string; body: string }) => {
          return gateway.putPatchProposal(principalRole, args.projectId, args.patchId, args.body);
        },
      }),
      shared_workspace_get_patch: tool({
        description: "Read your own or existing patch proposal record (read-only).",
        inputSchema: z.object({
          projectId: PROJECT_ID,
          patchId: z.string().min(1).max(128),
        }),
        execute: async ({ projectId, patchId }: { projectId: string; patchId: string }) => {
          return gateway.getPatchProposal(principalRole, projectId, patchId);
        },
      }),
    };
  }

  // orchestrator
  return {
    ...base,
    shared_workspace_write: tool({
      description:
        "Orchestrator: write or overwrite any path in the shared project file tree (canonical or staging).",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        path: z.string().min(1),
        content: z.string(),
      }),
      execute: async (args: { projectId: string; path: string; content: string }) => {
        return gateway.writeFile(principalRole, args.projectId, args.path, args.content);
      },
    }),
    shared_workspace_put_patch: tool({
      description: "Orchestrator: create/replace a patch proposal (sets status to pending).",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        patchId: z.string().min(1).max(128),
        body: z.string().min(1),
      }),
      execute: async (args: { projectId: string; patchId: string; body: string }) => {
        return gateway.putPatchProposal(principalRole, args.projectId, args.patchId, args.body);
      },
    }),
    shared_workspace_list_patches: tool({
      description: "Orchestrator: list patch ids and statuses.",
      inputSchema: z.object({ projectId: PROJECT_ID }),
      execute: async ({ projectId }: { projectId: string }) => {
        return gateway.listPatchProposals(principalRole, projectId);
      },
    }),
    shared_workspace_get_patch: tool({
      description: "Orchestrator: read full patch proposal record.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        patchId: z.string().min(1).max(128),
      }),
      execute: async ({ projectId, patchId }: { projectId: string; patchId: string }) => {
        return gateway.getPatchProposal(principalRole, projectId, patchId);
      },
    }),
    shared_workspace_approve_patch: tool({
      description: "Approve a pending patch (required before apply_patch unless workflow changes).",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        patchId: z.string().min(1).max(128),
      }),
      execute: async ({ projectId, patchId }: { projectId: string; patchId: string }) => {
        return gateway.approvePatch(principalRole, projectId, patchId);
      },
    }),
    shared_workspace_reject_patch: tool({
      description: "Reject a pending patch with optional reason.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        patchId: z.string().min(1).max(128),
        reason: z.string().optional(),
      }),
      execute: async ({
        projectId,
        patchId,
        reason,
      }: {
        projectId: string;
        patchId: string;
        reason?: string;
      }) => {
        return gateway.rejectPatch(principalRole, projectId, patchId, reason);
      },
    }),
    shared_workspace_apply_patch: tool({
      description:
        "Mark an approved patch as applied (does not run git apply yet — updates lifecycle only).",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        patchId: z.string().min(1).max(128),
      }),
      execute: async ({ projectId, patchId }: { projectId: string; patchId: string }) => {
        return gateway.applyPatch(principalRole, projectId, patchId);
      },
    }),
    shared_workspace_record_verification: tool({
      description: "Orchestrator: record verification output (same store as tester).",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        verificationId: z.string().min(1).max(128),
        payload: z.string().min(1),
      }),
      execute: async (args: { projectId: string; verificationId: string; payload: string }) => {
        return gateway.recordVerification(principalRole, args.projectId, args.verificationId, args.payload);
      },
    }),
    shared_workspace_register_project: tool({
      description:
        "Register shared project metadata (orchestrator-only). Creates/updates meta.json for the project id.",
      inputSchema: z.object({
        projectId: PROJECT_ID,
        label: z.string().optional().describe("Human-readable label stored in JSON meta."),
      }),
      execute: async (args: { projectId: string; label?: string }) => {
        const meta = JSON.stringify({
          label: args.label ?? args.projectId,
          updatedAt: new Date().toISOString(),
          kind: "edgeclaw-shared-project-v1",
        });
        return gateway.registerProjectMeta(principalRole, args.projectId, meta);
      },
    }),
  };
}
