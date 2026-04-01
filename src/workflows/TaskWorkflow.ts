/**
 * workflows/TaskWorkflow.ts
 *
 * Durable multi-step task execution pipeline for the OpenClaw-style planning system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE — What belongs where
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WORKFLOW (this file)
 *   Owns: step sequencing, ordering, retry loops, approval pause/resume
 *   orchestration, and progress reporting via TaskCoordinatorDO.
 *   Persists intermediate agent outputs to R2 so that any step can be replayed
 *   idempotently after a crash or lease expiry.
 *   Does NOT: perform AI calls, make business decisions, or hold mutable state.
 *
 * AGENTS (AnalystAgent, AuditAgent)
 *   Owns: domain-specific compute (AI calls, deterministic checks, structured
 *   output). Each agent appends its own worklog entry. Agents have no step
 *   awareness and make zero DO calls.
 *   Does NOT: know about the workflow step graph, manage leases, or touch
 *   coordinator state.
 *
 * DURABLE OBJECTS (TaskCoordinatorDO)
 *   Owns: per-task mutable state — current step, lease, completedSteps, approval
 *   lifecycle, event log. Serialises concurrent access via single-holder leases.
 *   Does NOT: perform compute, AI calls, or R2 writes.
 *
 * R2 (r2.ts helpers)
 *   Owns: durable persisted artifacts — task packets, intermediate agent outputs
 *   cached under `_wf_step_*.json`, final output, worklog entries.
 *   The crash-safety layer: if the workflow restarts, it reloads step outputs
 *   from R2 rather than re-running the corresponding agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP SEQUENCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   load_task → [analyst] → audit → approval_gate → finalize
 *
 *   Steps in [] are conditional based on taskType.
 *   Every step is idempotent: if already in coordinator.completedSteps, its
 *   cached output is loaded from R2 and the agent is NOT re-invoked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAILURE HANDLING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Each step is wrapped by runStepWithRetry():
 *   - On agent error: calls coordinatorFailStep() (records event + retryCount
 *     on the DO) then re-throws.
 *   - Retries: up to STEP_RETRY_CONFIG[step] attempts. Each attempt renews the
 *     coordinator heartbeat first. In production, add exponential backoff between
 *     attempts; the current implementation retries immediately.
 *   - If all retries fail: workflow returns { status: "failed", error }.
 *   - The task packet in R2 is NOT updated on failure — no partial completion.
 *   - Callers may re-invoke the workflow after fixing the root cause; completed
 *     steps will be skipped via the idempotency mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * APPROVAL PAUSE / RESUME DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   PAUSE (audit verdict = "revise" or "escalate_human"):
 *     1. All intermediate outputs (analyst, audit) are already in R2.
 *     2. coordinatorPauseForApproval() sets DO status = "paused_for_approval",
 *        approvalState = "pending".
 *     3. Workflow run returns { status: "paused_for_approval" }.
 *     4. Caller (e.g., index.ts) is responsible for notifying the reviewer via
 *        whatever channel is appropriate (ticketing, Slack, email).
 *        NOTE: AnalystAgent/AuditAgent must never send notifications
 *        directly — that constraint is explicitly enforced by the agent prompts.
 *
 *   RESUME (external trigger from human reviewer):
 *     Human reviewer signals via:
 *       POST /tasks/:taskId/resume
 *       body: { approved: boolean, reviewerId: string }
 *     The index.ts handler:
 *       1. Acquires the coordinator lease with a new workflowRunId.
 *       2. Calls coordinatorResumeAfterApproval() on the DO.
 *       3. Re-invokes TaskWorkflow.run() with resumeAfterApproval=true,
 *          approvedByHuman=<reviewer decision>.
 *
 *   RESUME (inside this workflow, resumeAfterApproval=true):
 *     1. Verify DO status is "paused_for_approval".
 *     2. Call coordinatorResumeAfterApproval() — DO transitions state.
 *     3. Load cached analyst/audit outputs from R2.
 *     4. If approved → run finalize step only.
 *     5. If rejected → mark coordinator failed, return { status: "rejected" }.
 *
 *   NOTE: In native Cloudflare Workflows (with step.waitForEvent("approval")),
 *   the pause and resume happen inside a single long-lived workflow run. The
 *   two-invocation pattern here is the functionally equivalent Workers-only
 *   implementation. Migrating to native Workflows requires only replacing the
 *   return-and-re-trigger logic with step.waitForEvent().
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STARTER INVOCATION EXAMPLE (from index.ts or a Cloudflare Workflow trigger)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   // Initial run
 *   const workflow = new TaskWorkflow();
 *   const result = await workflow.run(env, {
 *     taskId: "task-20260331-wifi-nac-001",
 *     workflowRunId: crypto.randomUUID(),
 *   });
 *   // result.status === "completed" | "failed" | "paused_for_approval" | "rejected"
 *
 *   // Resume after human approval
 *   const resumed = await workflow.run(env, {
 *     taskId: "task-20260331-wifi-nac-001",
 *     workflowRunId: crypto.randomUUID(),
 *     resumeAfterApproval: true,
 *     approvedByHuman: true,
 *   });
 */

import { AnalystAgent, AnalystStructuredOutput, AnalystTaskInput } from "../agents/AnalystAgent";
import { AuditAgent, AuditInput, AuditStructuredOutput } from "../agents/AuditAgent";
import {
  TaskCoordinatorState,
  coordinatorAcquireLease,
  coordinatorCompleteStep,
  coordinatorFailStep,
  coordinatorMarkTaskComplete,
  coordinatorPauseForApproval,
  coordinatorRenewHeartbeat,
  coordinatorResumeAfterApproval,
} from "../durable/TaskCoordinatorDO";
import {
  getArtifact,
  getTask,
  listArtifacts,
  listWorklogEntries,
  putArtifact,
  putTask,
} from "../lib/r2";
import { TaskPacket, TaskType } from "../lib/core-task-schema";
import { DurableObjectStubLike, Env } from "../lib/types";

// ─── Step name constants ──────────────────────────────────────────────────────

const STEP = {
  LOAD_TASK:     "load_task",
  ANALYST:       "analyst",
  AUDIT:         "audit",
  APPROVAL_GATE: "approval_gate",
  FINALIZE:      "finalize",
} as const;

type StepName = (typeof STEP)[keyof typeof STEP];

// ─── Per-step retry configuration ────────────────────────────────────────────
// WORKFLOW: retry logic is owned here, not inside agents.
// Agents should be pure compute; retries are an orchestration concern.

const STEP_RETRY_CONFIG: Record<StepName, number> = {
  load_task:     1,   // fail fast; missing TaskPacket is not a transient error
  analyst:       3,   // AI Gateway may have transient timeouts
  audit:         2,
  approval_gate: 1,   // pure routing logic; no external calls
  finalize:      3,   // R2 + DO writes can have transient failures
};

const LEASE_MS = 60_000; // 60 s; generous for AI Gateway round-trips

// R2 artifact key for caching a step's output between runs (crash safety).
const stepCacheKey = (step: StepName) => `_wf_step_${step}.json`;

// ─── Workflow I/O ─────────────────────────────────────────────────────────────

export interface WorkflowInput {
  taskId: string;
  /**
   * Unique per run. Used as the lease ownerId in TaskCoordinatorDO.
   * Callers must generate a fresh UUID for each invocation — including resumes.
   */
  workflowRunId: string;
  /**
   * Set to true when the workflow is re-triggered after a human makes an
   * approval decision. The workflow will skip already-completed steps by
   * loading cached outputs from R2.
   */
  resumeAfterApproval?: boolean;
  /** Human decision; only meaningful when resumeAfterApproval = true. */
  approvedByHuman?: boolean;
}

export interface WorkflowResult {
  taskId: string;
  status: "completed" | "failed" | "paused_for_approval" | "rejected";
  auditVerdict?: string;
  auditScore?: number;
  completedSteps: string[];
  error?: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface StepCtx {
  stub: DurableObjectStubLike;
  ownerId: string;
  taskId: string;
  env: Env;
}

type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ─── TaskWorkflow ─────────────────────────────────────────────────────────────

export class TaskWorkflow {
  async run(env: Env, input: WorkflowInput): Promise<WorkflowResult> {
    const { taskId, workflowRunId } = input;

    // DURABLE OBJECT: obtain the per-task coordinator stub.
    const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(taskId));
    const ctx: StepCtx = { stub, ownerId: workflowRunId, taskId, env };

    // ── Acquire lease ────────────────────────────────────────────────────────
    // WORKFLOW: concurrency guard — only one active workflow run per task.
    // DO: enforces single-holder lease; returns acquired=false if another
    //     run is currently active (lease not yet expired).
    const leaseResult = await coordinatorAcquireLease(stub, {
      ownerId: workflowRunId,
      leaseMs: LEASE_MS,
      stepName: STEP.LOAD_TASK,
    });

    if (!leaseResult.ok || !leaseResult.acquired) {
      return {
        taskId,
        status: "failed",
        completedSteps: [],
        error: leaseResult.reason ?? leaseResult.error ?? "Could not acquire coordinator lease",
      };
    }

    const coordState = leaseResult.state!;

    // ── Route: resume after human approval vs. forward pipeline ──────────────
    if (input.resumeAfterApproval) {
      return this.handleResume(ctx, coordState, input.approvedByHuman ?? false);
    }

    return this.executeForward(ctx, coordState);
  }

  // ─── Forward pipeline ──────────────────────────────────────────────────────

  private async executeForward(
    ctx: StepCtx,
    coordState: TaskCoordinatorState
  ): Promise<WorkflowResult> {
    const done = new Set(coordState.completedSteps);
    const ranSteps: StepName[] = [];

    // ── Step 1: load_task ─────────────────────────────────────────────────────
    // WORKFLOW: loads the TaskPacket from R2. Everything downstream depends on it.
    // R2: sole source of truth for the task definition.
    let task: TaskPacket;
    {
      const r = await this.runOrReload<TaskPacket>(ctx, STEP.LOAD_TASK, done, async () => {
        const packet = await getTask(ctx.env.R2_ARTIFACTS, ctx.taskId);
        if (!packet) throw new Error(`TaskPacket not found in R2 for taskId "${ctx.taskId}"`);
        return packet;
      });
      if (!r.ok) return this.buildFailResult(ctx.taskId, STEP.LOAD_TASK, r.error, coordState);
      task = r.value;
      ranSteps.push(STEP.LOAD_TASK);
    }

    // ── Step 2: analyst (conditional) ─────────────────────────────────────────
    // WORKFLOW: decides whether analysis is needed from taskType.
    //           AnalystAgent receives the TaskPacket + prior worklog; returns a
    //           structured output that DraftingAgent and AuditAgent consume.
    // AGENT (AnalystAgent): all AI inference and deterministic analysis; this
    //           workflow only wires inputs and stores the output.
    let analystOutput: AnalystStructuredOutput | null = null;
    if (needsAnalysis(task.taskType)) {
      const r = await this.runOrReload<AnalystStructuredOutput>(ctx, STEP.ANALYST, done, async () => {
        const priorWorklog = await listWorklogEntries(ctx.env.R2_WORKLOGS, ctx.taskId);
        const analystInput: AnalystTaskInput = {
          task,
          artifacts: [],  // TODO: populate from listArtifacts + getArtifact when content loading is wired
          priorWorklogEntries: priorWorklog,
        };
        const result = await new AnalystAgent().analyzeTask(ctx.env, analystInput);
        if (!result.ok) throw new Error(result.error ?? "AnalystAgent returned ok=false");
        return result.output;
      });
      if (!r.ok) return this.buildFailResult(ctx.taskId, STEP.ANALYST, r.error, coordState);
      analystOutput = r.value;
      ranSteps.push(STEP.ANALYST);
    }

    // ── Step 2: audit ─────────────────────────────────────────────────────────────────
    // WORKFLOW: always runs; routes based on verdict.
    //           Passes the analysist output to AuditAgent for quality checks.
    // AGENT (AuditAgent): all quality checks; verdict is "accept", "revise", or
    //           "escalate_human". Workflow does NOT reinterpret the verdict.
    let auditOutput: AuditStructuredOutput;
    {
      const r = await this.runOrReload<AuditStructuredOutput>(ctx, STEP.AUDIT, done, async () => {
        const priorWorklog = await listWorklogEntries(ctx.env.R2_WORKLOGS, ctx.taskId);
        const artifactKeys = await listArtifacts(ctx.env.R2_ARTIFACTS, ctx.taskId);
        const auditInput: AuditInput = {
          task,
          candidateType: "analyst_output",
          analystOutput: analystOutput ?? undefined,
          artifactKeys,
          priorWorklogEntries: priorWorklog,
        };
        const result = await new AuditAgent().auditOutput(ctx.env, auditInput);
        if (!result.ok) throw new Error(result.error ?? "AuditAgent returned ok=false");
        return result.output;
      });
      if (!r.ok) return this.buildFailResult(ctx.taskId, STEP.AUDIT, r.error, coordState);
      auditOutput = r.value;
      ranSteps.push(STEP.AUDIT);
    }
    // WORKFLOW: routing decision point based on audit verdict.
    //
    //   accept        → record step completed, proceed to finalize
    //   revise        → APPROVAL GATE: pause; human reviews and decides whether
    //                   to override or reject
    //   escalate_human → APPROVAL GATE: pause; mandatory human escalation
    //
    // DO: pauseForApproval() sets status = "paused_for_approval",
    //     approvalState = "pending". Intermediate outputs are already in R2.
    //     Workflow exits here and is re-triggered on resume.
    if (auditOutput.verdict !== "accept") {
      // APPROVAL GATE — output halted pending human review.
      // Caller must NOT distribute the draft until approval is confirmed.
      await coordinatorPauseForApproval(ctx.stub, {
        ownerId: ctx.ownerId,
        stepName: STEP.APPROVAL_GATE,
        note: `Audit verdict: ${auditOutput.verdict}. Score: ${auditOutput.score}/100. ${auditOutput.verdictRationale}`,
      });

      return {
        taskId: ctx.taskId,
        status: "paused_for_approval",
        auditVerdict: auditOutput.verdict,
        auditScore: auditOutput.score,
        completedSteps: [...ranSteps],
      };
    }

    // Audit passed — record the approval gate as completed.
    await coordinatorCompleteStep(ctx.stub, {
      ownerId: ctx.ownerId,
      stepName: STEP.APPROVAL_GATE,
      note: `Audit accepted (score=${auditOutput.score}/100).`,
    });
    ranSteps.push(STEP.APPROVAL_GATE);

    // ── Step 4: finalize ──────────────────────────────────────────────────────
    return this.runFinalize(ctx, task, analystOutput, auditOutput, ranSteps);
  }

  // ─── Resume path (after human approval) ───────────────────────────────────

  /**
   * handleResume
   *
   * Triggered when workflowInput.resumeAfterApproval = true.
   *
   * APPROVAL PAUSE / RESUME:
   *   The coordinator state must be "paused_for_approval". Any other state
   *   indicates the task was not paused (e.g., was already completed or failed),
   *   and the resume is rejected as an invalid transition.
   *
   *   coordinatorResumeAfterApproval() transitions the DO:
   *     approved → status = "running", approvalState = "approved"
   *     rejected → status = "failed",  approvalState = "rejected"
   *
   *   All agent outputs are loaded from the R2 step-cache — no agent re-runs.
   *   The finalize step then writes the final artifact and marks the task complete.
   *
   * NOTE: In native Cloudflare Workflows, step.waitForEvent("approval") provides
   * equivalent behaviour inside a single long-lived run. The two-invocation
   * pattern here is the Workers-only equivalent and is fully compatible with a
   * future native Workflows migration.
   */
  private async handleResume(
    ctx: StepCtx,
    coordState: TaskCoordinatorState,
    approvedByHuman: boolean
  ): Promise<WorkflowResult> {
    if (coordState.status !== "paused_for_approval") {
      return {
        taskId: ctx.taskId,
        status: "failed",
        completedSteps: coordState.completedSteps,
        error: `Resume requested but coordinator status is "${coordState.status}", expected "paused_for_approval".`,
      };
    }

    // DO: signal the human decision; transitions approval lifecycle state.
    await coordinatorResumeAfterApproval(ctx.stub, {
      ownerId: ctx.ownerId,
      approved: approvedByHuman,
      note: approvedByHuman ? "Human reviewer approved." : "Human reviewer rejected.",
    });

    if (!approvedByHuman) {
      return {
        taskId: ctx.taskId,
        status: "rejected",
        completedSteps: coordState.completedSteps,
        error: "Human reviewer rejected the output. No further processing.",
      };
    }

    // R2: load all cached intermediate outputs — no agents re-run on resume.
    const task = await loadStepCache<TaskPacket>(ctx, STEP.LOAD_TASK);
    if (!task) {
      return this.buildFailResult(ctx.taskId, STEP.FINALIZE, "load_task step-cache missing on approval resume", coordState);
    }

    const analystOutput = await loadStepCache<AnalystStructuredOutput>(ctx, STEP.ANALYST);
    const auditOutput   = await loadStepCache<AuditStructuredOutput>(ctx, STEP.AUDIT);

    if (!auditOutput) {
      return this.buildFailResult(ctx.taskId, STEP.FINALIZE, "audit step-cache missing on approval resume", coordState);
    }

    return this.runFinalize(ctx, task, analystOutput, auditOutput, [...coordState.completedSteps]);
  }

  // ─── Finalize step ─────────────────────────────────────────────────────────

  /**
   * runFinalize
   * Writes the composite final artifact to R2, updates the task packet status,
   * and marks the TaskCoordinatorDO complete.
   *
   * WORKFLOW: finalize is the only step that mutates the canonical task packet
   * (setting status = "completed"). No agent does this — only the workflow does.
   */
  private async runFinalize(
    ctx: StepCtx,
    task: TaskPacket,
    analystOutput: AnalystStructuredOutput | null,
    auditOutput: AuditStructuredOutput,
    ranSteps: string[]
  ): Promise<WorkflowResult> {
    const r = await runStepWithRetry<void>(
      ctx,
      STEP.FINALIZE,
      STEP_RETRY_CONFIG.finalize,
      async () => {
        const now = new Date().toISOString();

        // R2: write the composite final artifact.
        await putArtifact(
          ctx.env.R2_ARTIFACTS,
          ctx.taskId,
          "final-output.json",
          JSON.stringify({ taskId: ctx.taskId, completedAt: now, analystOutput, auditOutput }),
          "application/json"
        );

        // R2: update the task packet with terminal status.
        // WORKFLOW: only the workflow sets task.status = "completed"; agents never do.
        const updatedTask: TaskPacket = {
          ...task,
          status: "completed",
          approvalState: "approved",
          updatedAt: now,
        };
        await putTask(ctx.env.R2_ARTIFACTS, updatedTask);

        // DO: close out the coordinator; sets status = "completed".
        await coordinatorMarkTaskComplete(ctx.stub, {
          ownerId: ctx.ownerId,
          note: `Pipeline complete. Audit score: ${auditOutput.score}/100.`,
        });
      }
    );

    if (!r.ok) {
      return {
        taskId: ctx.taskId,
        status: "failed",
        auditVerdict: auditOutput.verdict,
        auditScore: auditOutput.score,
        completedSteps: ranSteps,
        error: r.error,
      };
    }

    ranSteps.push(STEP.FINALIZE);
    return {
      taskId: ctx.taskId,
      status: "completed",
      auditVerdict: auditOutput.verdict,
      auditScore: auditOutput.score,
      completedSteps: ranSteps,
    };
  }

  // ─── Step runner ───────────────────────────────────────────────────────────

  /**
   * runOrReload
   *
   * If the step is already in coordinator.completedSteps: load the cached
   * output from R2 (step-cache artifact) and skip the agent.
   *
   * Otherwise: run the step via runStepWithRetry, then persist the output
   * to the step-cache for crash recovery.
   *
   * This is the idempotency mechanism: same step + same task = same output,
   * always loaded from R2 on replay rather than re-invoking the agent.
   */
  private async runOrReload<T>(
    ctx: StepCtx,
    step: StepName,
    done: Set<string>,
    fn: () => Promise<T>
  ): Promise<StepResult<T>> {
    if (done.has(step)) {
      const cached = await loadStepCache<T>(ctx, step);
      if (!cached) {
        return { ok: false, error: `Step "${step}" in completedSteps but step-cache missing from R2.` };
      }
      return { ok: true, value: cached };
    }

    const r = await runStepWithRetry<T>(ctx, step, STEP_RETRY_CONFIG[step], fn);
    if (r.ok) {
      // R2: persist intermediate output for crash-safe replay.
      await putArtifact(
        ctx.env.R2_ARTIFACTS,
        ctx.taskId,
        stepCacheKey(step),
        JSON.stringify(r.value),
        "application/json"
      ).catch(() => undefined); // best-effort; a missing cache will just re-run the agent
    }
    return r;
  }

  // ─── Result helpers ────────────────────────────────────────────────────────

  private buildFailResult(
    taskId: string,
    step: string,
    error: string | undefined,
    coordState: TaskCoordinatorState
  ): WorkflowResult {
    return {
      taskId,
      status: "failed",
      completedSteps: coordState.completedSteps,
      error: error ?? `Step "${step}" failed`,
    };
  }
}

// ─── Step execution primitives ────────────────────────────────────────────────

/**
 * runStepWithRetry
 *
 * Wraps a step function with:
 *   1. Coordinator heartbeat renewal (proves liveness to the DO before each attempt).
 *   2. Retry loop up to maxAttempts.
 *   3. On final failure: coordinatorFailStep() records the error on the DO.
 *
 * FAILURE HANDLING:
 *   Each failed attempt increments coordinator.retryCount and records a StepEvent.
 *   On the final attempt, coordinator.status = "failed". The workflow caller
 *   decides whether to surface the error or attempt recovery at a higher level.
 *
 *   TODO (production): add exponential backoff between attempts, a separate
 *   per-step retry counter in coordinator state, and a max-total-retry cap per task.
 */
async function runStepWithRetry<T>(
  ctx: StepCtx,
  step: StepName,
  maxAttempts: number,
  fn: () => Promise<T>
): Promise<StepResult<T>> {
  let lastError = "Unknown error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // WORKFLOW: renew heartbeat before each attempt.
    // DO: heartbeatAt updated; allows external monitors to detect stalled tasks.
    await coordinatorRenewHeartbeat(ctx.stub, { ownerId: ctx.ownerId }).catch(() => undefined);

    try {
      const value = await fn();
      // WORKFLOW: record the successful step on the coordinator.
      // DO: step added to completedSteps, events log updated.
      await coordinatorCompleteStep(ctx.stub, {
        ownerId: ctx.ownerId,
        stepName: step,
        note: attempt > 1 ? `Succeeded on attempt ${attempt}` : undefined,
      });
      return { ok: true, value };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);

      // WORKFLOW: record the failure on the coordinator for every failed attempt.
      // DO: retryCount incremented, status = "failed" (temporary; next acquire resets to "running").
      await coordinatorFailStep(ctx.stub, {
        ownerId: ctx.ownerId,
        stepName: step,
        errorMessage: `Attempt ${attempt}/${maxAttempts}: ${lastError}`,
      }).catch(() => undefined); // best-effort; do not mask the original error
    }
  }

  return { ok: false, error: `Step "${step}" failed after ${maxAttempts} attempt(s): ${lastError}` };
}

// ─── R2 step-cache helpers ────────────────────────────────────────────────────

async function loadStepCache<T>(ctx: StepCtx, step: StepName): Promise<T | null> {
  const artifact = await getArtifact(ctx.env.R2_ARTIFACTS, ctx.taskId, stepCacheKey(step));
  if (!artifact) return null;
  return artifact.body as T;
}

// ─── Task-type routing helpers ────────────────────────────────────────────────

/**
 * needsAnalysis
 * Tasks that require AnalystAgent to run before drafting.
 * These tasks have incident evidence, policy changes, or technical artifacts
 * that must be interpreted before a document can be produced.
 */
function needsAnalysis(taskType: TaskType): boolean {
  return (["incident_triage", "root_cause_analysis", "change_review"] as TaskType[]).includes(taskType);
}
