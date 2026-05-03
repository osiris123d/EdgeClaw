/**
 * Conservative follow-up task generation after coordinator-led (debug) runs.
 * Pure policy — persistence lives in {@link appendFollowUpCoordinatorTasksAfterRun}.
 */

import type { CodingCollaborationLoopResult } from "../agents/codingLoop/codingLoopTypes";
import type {
  CoordinatorTask,
  CoordinatorTaskGenerationReason,
  CoordinatorTaskRole,
  CoordinatorTaskSource,
} from "./types";

export const MAX_FOLLOW_UP_TASKS_PER_RUN = 2;

/** Dedupe window for same (parentTaskId, generationReason) without matching run id. */
export const FOLLOW_UP_DEDUP_WINDOW_MS = 60 * 60 * 1000;

export interface FollowUpTaskSpec {
  taskId: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  assignedRole: CoordinatorTaskRole;
  taskSource: Extract<CoordinatorTaskSource, "coordinator_generated">;
  generationReason: CoordinatorTaskGenerationReason;
  parentTaskId: string;
  spawnedByRunId: string;
}

function loopTerminalSuccess(status: string): boolean {
  return (
    status === "completed_success" ||
    status === "stop_success_applied" ||
    status === "stop_success_approved_pending_apply"
  );
}

function hasDuplicateFollowUp(
  existing: CoordinatorTask[],
  parentTaskId: string,
  reason: CoordinatorTaskGenerationReason,
  runId: string,
  nowMs: number
): boolean {
  return existing.some((t) => {
    if (t.parentTaskId !== parentTaskId || t.generationReason !== reason) return false;
    if (t.spawnedByRunId === runId) return true;
    const ts = Date.parse(t.createdAt);
    if (!Number.isFinite(ts)) return false;
    return ts >= nowMs - FOLLOW_UP_DEDUP_WINDOW_MS;
  });
}

function newFollowUpTaskId(): string {
  return `followup-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Decide up to {@link MAX_FOLLOW_UP_TASKS_PER_RUN} follow-up specs from a finished loop or abort.
 * Ordering: missing_dependency → verification_failure → blocker_investigation.
 */
export function decideFollowUpTaskSpecs(input: {
  projectId: string;
  parentTaskId: string;
  runId: string;
  result?: CodingCollaborationLoopResult | null;
  parentTitle?: string;
  existingTasks: CoordinatorTask[];
  /** When the loop threw before a structured result — single investigation task. */
  abortMessage?: string | null;
  nowMs?: number;
}): FollowUpTaskSpec[] {
  const nowMs = input.nowMs ?? Date.now();
  const { projectId, parentTaskId, runId, existingTasks } = input;
  const parentLabel = input.parentTitle?.trim() || parentTaskId;

  if (input.abortMessage?.trim()) {
    const reason: CoordinatorTaskGenerationReason = "blocker_investigation";
    if (hasDuplicateFollowUp(existingTasks, parentTaskId, reason, runId, nowMs)) return [];
    const msg = input.abortMessage.trim().slice(0, 400);
    return [
      {
        taskId: newFollowUpTaskId(),
        projectId,
        title: `Investigate run failure (${parentLabel})`,
        description:
          `Orchestration run ${runId} aborted before completion.\n\n` +
          `Parent task: ${parentTaskId}\n` +
          `Error: ${msg}`,
        acceptanceCriteria:
          "Identify root cause (workspace, model, tools, or code), document findings, and either fix or file a scoped follow-up.",
        assignedRole: "coordinator",
        taskSource: "coordinator_generated",
        generationReason: reason,
        parentTaskId,
        spawnedByRunId: runId,
      },
    ];
  }

  const result = input.result;
  if (!result) return [];

  if (loopTerminalSuccess(result.status)) return [];

  const candidates: FollowUpTaskSpec[] = [];

  if (result.status === "blocked_no_shared_workspace") {
    const reason: CoordinatorTaskGenerationReason = "missing_dependency";
    if (!hasDuplicateFollowUp(existingTasks, parentTaskId, reason, runId, nowMs)) {
      candidates.push({
        taskId: newFollowUpTaskId(),
        projectId,
        title: `Shared workspace prerequisite (${parentLabel})`,
        description:
          `Run ${runId} stopped with blocked_no_shared_workspace. ` +
          `Ensure SHARED_WORKSPACE_KV is bound and the project sharedProjectId is valid before re-running parent task ${parentTaskId}.`,
        acceptanceCriteria:
          "Confirm KV binding and workspace health; re-run orchestration or adjust project sharedProjectId per operator checklist.",
        assignedRole: "coordinator",
        taskSource: "coordinator_generated",
        generationReason: reason,
        parentTaskId,
        spawnedByRunId: runId,
      });
    }
  }

  const anyTesterFail = result.iterations.some((it) => it.testerVerdict === "fail");
  if (anyTesterFail) {
    const reason: CoordinatorTaskGenerationReason = "verification_failure";
    if (!hasDuplicateFollowUp(existingTasks, parentTaskId, reason, runId, nowMs)) {
      const last = result.iterations[result.iterations.length - 1];
      candidates.push({
        taskId: newFollowUpTaskId(),
        projectId,
        title: `Fix / re-verify after tester failure (${parentLabel})`,
        description:
          `Run ${runId} on parent ${parentTaskId} had at least one tester verdict FAIL.\n` +
          `Terminal loop status: ${result.status}\n` +
          `Last iteration: ${last?.iteration ?? "?"}, verdict=${last?.testerVerdict ?? "?"}`,
        acceptanceCriteria:
          "Address failing verification scope; produce a minimal patch and re-run tester until PASS or document why work is blocked.",
        assignedRole: "coder",
        taskSource: "coordinator_generated",
        generationReason: reason,
        parentTaskId,
        spawnedByRunId: runId,
      });
    }
  }

  if (result.status !== "needs_user_approval") {
    const reason: CoordinatorTaskGenerationReason = "blocker_investigation";
    if (!hasDuplicateFollowUp(existingTasks, parentTaskId, reason, runId, nowMs)) {
      const skipGenericBlocker =
        result.status === "blocked_no_shared_workspace" &&
        candidates.some((c) => c.generationReason === "missing_dependency");
      if (!skipGenericBlocker) {
        candidates.push({
          taskId: newFollowUpTaskId(),
          projectId,
          title: `Investigate non-success run (${parentLabel})`,
          description:
            `Run ${runId} ended with status **${result.status}** (parent ${parentTaskId}).\n\n` +
            `Summary (truncated): ${(result.summaryForUser ?? "").slice(0, 600)}`,
          acceptanceCriteria:
            "Classify the failure (guardrail vs product vs infra), capture evidence, and define the next concrete engineering step.",
          assignedRole: "coordinator",
          taskSource: "coordinator_generated",
          generationReason: reason,
          parentTaskId,
          spawnedByRunId: runId,
        });
      }
    }
  }

  const seen = new Set<CoordinatorTaskGenerationReason>();
  const ordered: FollowUpTaskSpec[] = [];
  for (const c of candidates) {
    if (seen.has(c.generationReason)) continue;
    seen.add(c.generationReason);
    ordered.push(c);
    if (ordered.length >= MAX_FOLLOW_UP_TASKS_PER_RUN) break;
  }
  return ordered;
}
