/**
 * durable/TaskCoordinatorDO.ts
 * Coordinates exactly one task per DO instance with lease-based mutation control.
 *
 * Why per-task DO instead of one giant singleton:
 * - isolation: each task has independent state/locks
 * - contention control: hot tasks do not block unrelated tasks
 * - natural horizontal scale: object IDs shard automatically
 */

import { DurableObjectStateLike, DurableObjectStubLike } from "../lib/types";

export type CoordinatorStatus =
  | "new"
  | "running"
  | "paused_for_approval"
  | "completed"
  | "failed";

export type CoordinatorApprovalState = "not_required" | "pending" | "approved" | "rejected";

export interface LeaseInfo {
  ownerId: string;
  leaseUntil: string;
}

export interface StepEvent {
  stepName: string;
  outcome: "completed" | "failed" | "paused";
  at: string;
  note?: string;
}

export interface TaskCoordinatorState {
  taskId: string;
  status: CoordinatorStatus;
  retryCount: number;
  heartbeatAt: string | null;
  approvalState: CoordinatorApprovalState;
  lease: LeaseInfo | null;
  currentStep: string | null;
  completedSteps: string[];
  lastError: string | null;
  events: StepEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface InitializeTaskRequest {
  taskId: string;
  initialStatus?: CoordinatorStatus;
  approvalState?: CoordinatorApprovalState;
}
export interface InitializeTaskResponse {
  ok: boolean;
  state?: TaskCoordinatorState;
  error?: string;
}

export interface AcquireLeaseRequest {
  ownerId: string;
  leaseMs?: number;
  stepName?: string;
}
export interface AcquireLeaseResponse {
  ok: boolean;
  acquired: boolean;
  state?: TaskCoordinatorState;
  reason?: string;
  error?: string;
}

export interface RenewHeartbeatRequest {
  ownerId: string;
}
export interface RenewHeartbeatResponse {
  ok: boolean;
  state?: TaskCoordinatorState;
  error?: string;
}

export interface CompleteStepRequest {
  ownerId: string;
  stepName: string;
  note?: string;
}
export interface CompleteStepResponse {
  ok: boolean;
  state?: TaskCoordinatorState;
  error?: string;
}

export interface FailStepRequest {
  ownerId: string;
  stepName: string;
  errorMessage: string;
}
export interface FailStepResponse {
  ok: boolean;
  state?: TaskCoordinatorState;
  error?: string;
}

export interface PauseForApprovalRequest {
  ownerId: string;
  stepName: string;
  note?: string;
}
export interface PauseForApprovalResponse {
  ok: boolean;
  state?: TaskCoordinatorState;
  error?: string;
}

export interface ResumeAfterApprovalRequest {
  ownerId: string;
  approved: boolean;
  note?: string;
}
export interface ResumeAfterApprovalResponse {
  ok: boolean;
  state?: TaskCoordinatorState;
  error?: string;
}

export interface MarkTaskCompleteRequest {
  ownerId: string;
  note?: string;
}
export interface MarkTaskCompleteResponse {
  ok: boolean;
  state?: TaskCoordinatorState;
  error?: string;
}

const STORAGE_KEY = "coordinator_state";
const DEFAULT_LEASE_MS = 20_000;

export class TaskCoordinatorDO {
  private readonly state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike, env: unknown) {
    this.state = state;
    void env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/state") {
        const current = await this.readState();
        if (!current) return json({ ok: false, error: "Task not initialized" }, 404);
        return json({ ok: true, state: current }, 200);
      }

      if (request.method !== "POST") {
        console.warn(`Unsupported method on coordinator: ${request.method}`);
        return json({ ok: false, error: "Unsupported method" }, 405);
      }

      if (url.pathname === "/initialize-task") {
        const body = (await request.json()) as InitializeTaskRequest;
        return json(await this.initializeTask(body), 200);
      }
      if (url.pathname === "/acquire-lease") {
        const body = (await request.json()) as AcquireLeaseRequest;
        return json(await this.acquireLease(body), 200);
      }
      if (url.pathname === "/renew-heartbeat") {
        const body = (await request.json()) as RenewHeartbeatRequest;
        return json(await this.renewHeartbeat(body), 200);
      }
      if (url.pathname === "/complete-step") {
        const body = (await request.json()) as CompleteStepRequest;
        return json(await this.completeStep(body), 200);
      }
      if (url.pathname === "/fail-step") {
        const body = (await request.json()) as FailStepRequest;
        return json(await this.failStep(body), 200);
      }
      if (url.pathname === "/pause-for-approval") {
        const body = (await request.json()) as PauseForApprovalRequest;
        return json(await this.pauseForApproval(body), 200);
      }
      if (url.pathname === "/resume-after-approval") {
        const body = (await request.json()) as ResumeAfterApprovalRequest;
        return json(await this.resumeAfterApproval(body), 200);
      }
      if (url.pathname === "/mark-task-complete") {
        const body = (await request.json()) as MarkTaskCompleteRequest;
        return json(await this.markTaskComplete(body), 200);
      }

      return json({ ok: false, error: "Unknown route" }, 404);
    } catch (error: unknown) {
      console.error("Coordinator fetch failed:", error);
      return json({ ok: false, error: toError(error) }, 500);
    }
  }

  private async initializeTask(body: InitializeTaskRequest): Promise<InitializeTaskResponse> {
    if (!body.taskId || body.taskId.trim().length === 0) {
      return { ok: false, error: "taskId is required" };
    }

    const existing = await this.readState();
    if (existing) {
      return { ok: false, error: "Task already initialized", state: existing };
    }

    const now = new Date().toISOString();
    const state: TaskCoordinatorState = {
      taskId: body.taskId,
      status: body.initialStatus || "new",
      retryCount: 0,
      heartbeatAt: null,
      approvalState: body.approvalState || "not_required",
      lease: null,
      currentStep: null,
      completedSteps: [],
      lastError: null,
      events: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.writeState(state);
    return { ok: true, state };
  }

  private async acquireLease(body: AcquireLeaseRequest): Promise<AcquireLeaseResponse> {
    const state = await this.readState();
    if (!state) return { ok: false, acquired: false, error: "Task not initialized" };
    if (!body.ownerId) return { ok: false, acquired: false, error: "ownerId is required" };

    const now = Date.now();
    const leaseMs = Math.max(1000, body.leaseMs || DEFAULT_LEASE_MS);
    const leaseIsActive = state.lease ? Date.parse(state.lease.leaseUntil) > now : false;

    if (leaseIsActive && state.lease?.ownerId !== body.ownerId) {
      return {
        ok: true,
        acquired: false,
        reason: `Lease held by ${state.lease?.ownerId}`,
        state,
      };
    }

    const leaseUntil = new Date(now + leaseMs).toISOString();
    state.lease = { ownerId: body.ownerId, leaseUntil };
    state.status = state.status === "new" ? "running" : state.status;
    state.currentStep = body.stepName || state.currentStep;
    state.heartbeatAt = new Date(now).toISOString();
    state.updatedAt = state.heartbeatAt;

    await this.writeState(state);
    return { ok: true, acquired: true, state };
  }

  private async renewHeartbeat(body: RenewHeartbeatRequest): Promise<RenewHeartbeatResponse> {
    const state = await this.readState();
    if (!state) return { ok: false, error: "Task not initialized" };

    const leaseError = this.assertLeaseOwner(state, body.ownerId);
    if (leaseError) return { ok: false, error: leaseError };

    state.heartbeatAt = new Date().toISOString();
    state.updatedAt = state.heartbeatAt;
    await this.writeState(state);
    return { ok: true, state };
  }

  private async completeStep(body: CompleteStepRequest): Promise<CompleteStepResponse> {
    const state = await this.readState();
    if (!state) return { ok: false, error: "Task not initialized" };
    if (!body.stepName) return { ok: false, error: "stepName is required" };

    const leaseError = this.assertLeaseOwner(state, body.ownerId);
    if (leaseError) return { ok: false, error: leaseError };

    if (!state.completedSteps.includes(body.stepName)) {
      state.completedSteps.push(body.stepName);
    }
    state.currentStep = null;
    state.lastError = null;
    state.status = "running";
    state.events.push({
      stepName: body.stepName,
      outcome: "completed",
      at: new Date().toISOString(),
      note: body.note,
    });
    state.updatedAt = new Date().toISOString();

    await this.writeState(state);
    return { ok: true, state };
  }

  private async failStep(body: FailStepRequest): Promise<FailStepResponse> {
    const state = await this.readState();
    if (!state) return { ok: false, error: "Task not initialized" };
    if (!body.stepName || !body.errorMessage) {
      return { ok: false, error: "stepName and errorMessage are required" };
    }

    const leaseError = this.assertLeaseOwner(state, body.ownerId);
    if (leaseError) return { ok: false, error: leaseError };

    state.retryCount += 1;
    state.currentStep = body.stepName;
    state.lastError = body.errorMessage;
    state.status = "failed";
    state.events.push({
      stepName: body.stepName,
      outcome: "failed",
      at: new Date().toISOString(),
      note: body.errorMessage,
    });
    state.updatedAt = new Date().toISOString();

    await this.writeState(state);
    return { ok: true, state };
  }

  private async pauseForApproval(body: PauseForApprovalRequest): Promise<PauseForApprovalResponse> {
    const state = await this.readState();
    if (!state) return { ok: false, error: "Task not initialized" };
    if (!body.stepName) return { ok: false, error: "stepName is required" };

    const leaseError = this.assertLeaseOwner(state, body.ownerId);
    if (leaseError) return { ok: false, error: leaseError };

    state.currentStep = body.stepName;
    state.status = "paused_for_approval";
    state.approvalState = "pending";
    state.events.push({
      stepName: body.stepName,
      outcome: "paused",
      at: new Date().toISOString(),
      note: body.note,
    });
    state.updatedAt = new Date().toISOString();

    await this.writeState(state);
    return { ok: true, state };
  }

  private async resumeAfterApproval(body: ResumeAfterApprovalRequest): Promise<ResumeAfterApprovalResponse> {
    const state = await this.readState();
    if (!state) return { ok: false, error: "Task not initialized" };

    const leaseError = this.assertLeaseOwner(state, body.ownerId);
    if (leaseError) return { ok: false, error: leaseError };

    state.approvalState = body.approved ? "approved" : "rejected";
    state.status = body.approved ? "running" : "failed";
    state.lastError = body.approved ? null : "Approval rejected";
    state.updatedAt = new Date().toISOString();

    if (!body.approved && state.currentStep) {
      state.retryCount += 1;
      state.events.push({
        stepName: state.currentStep,
        outcome: "failed",
        at: state.updatedAt,
        note: body.note || "Rejected during approval",
      });
    }

    await this.writeState(state);
    return { ok: true, state };
  }

  private async markTaskComplete(body: MarkTaskCompleteRequest): Promise<MarkTaskCompleteResponse> {
    const state = await this.readState();
    if (!state) return { ok: false, error: "Task not initialized" };

    const leaseError = this.assertLeaseOwner(state, body.ownerId);
    if (leaseError) return { ok: false, error: leaseError };

    state.status = "completed";
    state.currentStep = null;
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    if (body.note) {
      state.events.push({
        stepName: "__task__",
        outcome: "completed",
        at: state.updatedAt,
        note: body.note,
      });
    }

    await this.writeState(state);
    return { ok: true, state };
  }

  private assertLeaseOwner(state: TaskCoordinatorState, ownerId: string): string | null {
    if (!ownerId) return "ownerId is required";
    if (!state.lease) return "Lease not acquired";
    if (Date.parse(state.lease.leaseUntil) <= Date.now()) return "Lease expired";
    if (state.lease.ownerId !== ownerId) return `Lease owned by ${state.lease.ownerId}`;
    return null;
  }

  private async readState(): Promise<TaskCoordinatorState | null> {
    return (await this.state.storage.get<TaskCoordinatorState>(STORAGE_KEY)) ?? null;
  }

  private async writeState(state: TaskCoordinatorState): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, state);
  }
}

/**
 * Example calls from an Agent/Workflow:
 *
 * const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName(taskId));
 *
 * await coordinatorInitialize(stub, { taskId });
 * const lease = await coordinatorAcquireLease(stub, { ownerId: workflowRunId, stepName: "analysis" });
 * if (!lease.acquired) return;
 *
 * await coordinatorRenewHeartbeat(stub, { ownerId: workflowRunId });
 * await coordinatorCompleteStep(stub, { ownerId: workflowRunId, stepName: "analysis" });
 * await coordinatorPauseForApproval(stub, { ownerId: workflowRunId, stepName: "publish" });
 * await coordinatorResumeAfterApproval(stub, { ownerId: workflowRunId, approved: true });
 * await coordinatorMarkTaskComplete(stub, { ownerId: workflowRunId });
 */

export async function coordinatorInitialize(
  stub: DurableObjectStubLike,
  body: InitializeTaskRequest
): Promise<InitializeTaskResponse> {
  return postJson<InitializeTaskResponse>(stub, "/initialize-task", body);
}

export async function coordinatorAcquireLease(
  stub: DurableObjectStubLike,
  body: AcquireLeaseRequest
): Promise<AcquireLeaseResponse> {
  return postJson<AcquireLeaseResponse>(stub, "/acquire-lease", body);
}

export async function coordinatorRenewHeartbeat(
  stub: DurableObjectStubLike,
  body: RenewHeartbeatRequest
): Promise<RenewHeartbeatResponse> {
  return postJson<RenewHeartbeatResponse>(stub, "/renew-heartbeat", body);
}

export async function coordinatorCompleteStep(
  stub: DurableObjectStubLike,
  body: CompleteStepRequest
): Promise<CompleteStepResponse> {
  return postJson<CompleteStepResponse>(stub, "/complete-step", body);
}

export async function coordinatorFailStep(
  stub: DurableObjectStubLike,
  body: FailStepRequest
): Promise<FailStepResponse> {
  return postJson<FailStepResponse>(stub, "/fail-step", body);
}

export async function coordinatorPauseForApproval(
  stub: DurableObjectStubLike,
  body: PauseForApprovalRequest
): Promise<PauseForApprovalResponse> {
  return postJson<PauseForApprovalResponse>(stub, "/pause-for-approval", body);
}

export async function coordinatorResumeAfterApproval(
  stub: DurableObjectStubLike,
  body: ResumeAfterApprovalRequest
): Promise<ResumeAfterApprovalResponse> {
  return postJson<ResumeAfterApprovalResponse>(stub, "/resume-after-approval", body);
}

export async function coordinatorMarkTaskComplete(
  stub: DurableObjectStubLike,
  body: MarkTaskCompleteRequest
): Promise<MarkTaskCompleteResponse> {
  return postJson<MarkTaskCompleteResponse>(stub, "/mark-task-complete", body);
}

async function postJson<T>(stub: DurableObjectStubLike, path: string, body: unknown): Promise<T> {
  const response = await stub.fetch(`https://do${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown coordinator error";
}
