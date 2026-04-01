import { describe, expect, it } from "vitest";
import { coordinatorInitialize } from "../../src/durable/TaskCoordinatorDO";
import { TaskPacket } from "../../src/lib/core-task-schema";
import { getArtifact, getTask, putTask } from "../../src/lib/r2";
import { TaskWorkflow } from "../../src/workflows/TaskWorkflow";
import { createMockEnv } from "../helpers/cloudflare-mocks";

function buildTask(taskId: string, taskType: TaskPacket["taskType"]): TaskPacket {
  const now = "2026-04-01T12:00:00.000Z";
  return {
    taskId,
    taskType,
    domain: "wifi",
    title: `Test task ${taskId}`,
    goal: "Run workflow test",
    definitionOfDone: [],
    allowedTools: ["r2.read", "worklog.append"],
    forbiddenActions: ["forbidden_action_marker"],
    inputArtifacts: [],
    dependencies: [],
    status: "queued",
    approvalState: "not_required",
    escalationRules: [],
    createdAt: now,
    updatedAt: now,
    assignedAgentRole: "dispatcher",
    metadata: { source: "workflow" },
  };
}

describe("TaskWorkflow orchestration", () => {
  it("completes end-to-end for report_draft task", async () => {
    const env = createMockEnv();
    const taskId = "task-integration-complete";
    const task = buildTask(taskId, "report_draft");
    task.forbiddenActions = []; // avoid forced audit escalation in draft forbidden-action section

    const saved = await putTask(env.R2_ARTIFACTS, task);
    expect(saved.ok).toBe(true);

    const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(taskId));
    const init = await coordinatorInitialize(stub, { taskId, initialStatus: "new" });
    expect(init.ok).toBe(true);

    const workflow = new TaskWorkflow();
    const result = await workflow.run(env, {
      taskId,
      workflowRunId: "run-complete-1",
    });

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toContain("finalize");

    const updatedTask = await getTask(env.R2_ARTIFACTS, taskId);
    expect(updatedTask?.status).toBe("completed");
    expect(updatedTask?.approvalState).toBe("approved");

    const finalArtifact = await getArtifact(env.R2_ARTIFACTS, taskId, "final-output.json");
    expect(finalArtifact).not.toBeNull();
  });

  it("pauses for approval then resumes to completion", async () => {
    const env = createMockEnv();
    const taskId = "task-integration-approval";
    const task = buildTask(taskId, "change_review");
    // For change_review, drafting emits CAB note that includes forbidden actions,
    // which intentionally triggers audit escalation and approval pause.

    const saved = await putTask(env.R2_ARTIFACTS, task);
    expect(saved.ok).toBe(true);

    const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(taskId));
    const init = await coordinatorInitialize(stub, { taskId, initialStatus: "new" });
    expect(init.ok).toBe(true);

    const workflow = new TaskWorkflow();
    const first = await workflow.run(env, {
      taskId,
      workflowRunId: "run-approval-1",
    });

    expect(first.status).toBe("paused_for_approval");
    expect(first.auditVerdict).toBeDefined();

    // Reuse same owner ID so lease can be reacquired immediately in deterministic tests.
    const resumed = await workflow.run(env, {
      taskId,
      workflowRunId: "run-approval-1",
      resumeAfterApproval: true,
      approvedByHuman: true,
    });

    expect(resumed.status).toBe("completed");
    const updatedTask = await getTask(env.R2_ARTIFACTS, taskId);
    expect(updatedTask?.status).toBe("completed");
  });

  // Expand later:
  // - test retry behavior by injecting transient failures in mocked R2/DO bindings
  // - test resume-after-reject path and expected terminal rejected status
  // - test stale step-cache scenarios (completedSteps references missing cache)
});
