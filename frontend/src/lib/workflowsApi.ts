/**
 * Workflows API client — frontend/src/lib/workflowsApi.ts
 *
 * Thin, typed wrapper over the /api/workflows endpoints served by the
 * MainAgent Durable Object.  Follows the same pattern as tasksApi.ts:
 * a shared `requestJson` helper, per-type normalizers, and plain exported
 * async functions.
 *
 * ── Endpoint contract (workflowsRoutes.ts) ──────────────────────────────────
 *
 *   GET    /api/workflows                           → WorkflowDefinitionsListResponse
 *   POST   /api/workflows                           → WorkflowDefinition (201)
 *   PATCH  /api/workflows/:id                       → WorkflowDefinition
 *   DELETE /api/workflows/:id                       → 204
 *   POST   /api/workflows/:id/toggle  { enabled }   → WorkflowDefinition
 *   POST   /api/workflows/:id/launch                → WorkflowRun (201)
 *
 *   GET    /api/workflows/runs                      → WorkflowRunsListResponse
 *   GET    /api/workflows/runs/:id                  → WorkflowRun
 *   POST   /api/workflows/runs/:id/terminate        → WorkflowRun
 *   POST   /api/workflows/runs/:id/resume           → WorkflowRun
 *   POST   /api/workflows/runs/:id/restart          → WorkflowRun
 *   POST   /api/workflows/runs/:id/approve          → WorkflowRun
 *   POST   /api/workflows/runs/:id/reject           → WorkflowRun
 *   POST   /api/workflows/runs/:id/event            → WorkflowRun
 *
 * ── Adapter pattern ──────────────────────────────────────────────────────────
 *
 * All public functions delegate to a `WorkflowsAdapter` instance.  Two
 * implementations are provided:
 *
 *   httpAdapter  — real fetch calls to the backend (used in production)
 *   mockAdapter  — in-memory stub with seed data (used during development)
 *
 * Switch between them by changing the `USE_MOCK` constant below.  The mock is
 * intentionally stateful so CRUD operations reflect immediately in the UI
 * without any backend work.
 *
 * ── Swapping to real endpoints ───────────────────────────────────────────────
 *
 * Set `USE_MOCK = false` once the backend SQLite schema and Cloudflare
 * Workflows bindings are in place.  No other changes are required.
 */

import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowDefinitionsListResponse,
  WorkflowRunsListResponse,
  CreateWorkflowDefinitionInput,
  UpdateWorkflowDefinitionInput,
  LaunchWorkflowInput,
} from "../types/workflows";

// Re-export input types so callers can import from one place.
export type {
  CreateWorkflowDefinitionInput,
  UpdateWorkflowDefinitionInput,
  LaunchWorkflowInput,
} from "../types/workflows";

// ── Additional API-level types ─────────────────────────────────────────────────

/** Payload for approve / reject actions on a waiting run. */
export interface WorkflowApprovalData {
  comment?:    string;
  approvedBy?: string;
}

/** Payload for sending an external event to a waiting workflow. */
export interface WorkflowEventPayload {
  eventType: string;
  data?:     Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTER CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════

interface WorkflowsAdapter {
  // ── Definitions ─────────────────────────────────────────────────────────────
  getDefinitions(signal?: AbortSignal): Promise<WorkflowDefinitionsListResponse>;
  createDefinition(input: CreateWorkflowDefinitionInput, signal?: AbortSignal): Promise<WorkflowDefinition>;
  updateDefinition(id: string, input: UpdateWorkflowDefinitionInput, signal?: AbortSignal): Promise<WorkflowDefinition>;
  deleteDefinition(id: string, signal?: AbortSignal): Promise<void>;
  toggleDefinition(id: string, enabled: boolean, signal?: AbortSignal): Promise<WorkflowDefinition>;
  launchWorkflow(definitionId: string, input?: LaunchWorkflowInput, signal?: AbortSignal): Promise<WorkflowRun>;

  // ── Runs ────────────────────────────────────────────────────────────────────
  getRuns(workflowDefinitionId?: string, signal?: AbortSignal): Promise<WorkflowRunsListResponse>;
  getRun(id: string, signal?: AbortSignal): Promise<WorkflowRun>;
  terminateRun(id: string, signal?: AbortSignal): Promise<WorkflowRun>;
  resumeRun(id: string, signal?: AbortSignal): Promise<WorkflowRun>;
  restartRun(id: string, signal?: AbortSignal): Promise<WorkflowRun>;
  approveRun(id: string, data?: WorkflowApprovalData, signal?: AbortSignal): Promise<WorkflowRun>;
  rejectRun(id: string, data?: WorkflowApprovalData, signal?: AbortSignal): Promise<WorkflowRun>;
  sendEvent(id: string, event: WorkflowEventPayload, signal?: AbortSignal): Promise<WorkflowRun>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP ADAPTER
// ═══════════════════════════════════════════════════════════════════════════════

const BASE = "/api/workflows";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(
      `[workflowsApi] Network error reaching ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      detail = typeof body.error === "string" ? body.error : JSON.stringify(body);
    } catch {
      try { detail = await res.text(); } catch { /* fall through */ }
    }
    throw new Error(`[workflowsApi] ${res.status} — ${detail}`);
  }

  // 204 No Content — callers of delete expect void.
  if (res.status === 204) return undefined as unknown as T;

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`[workflowsApi] Response from ${url} was not valid JSON`);
  }
}

function normalizeDefinition(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error("[workflowsApi] Unexpected workflow definition shape");
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.name !== "string") {
    throw new Error("[workflowsApi] Definition missing required fields (id, name)");
  }
  return d as unknown as WorkflowDefinition;
}

function normalizeRun(raw: unknown): WorkflowRun {
  if (!raw || typeof raw !== "object") {
    throw new Error("[workflowsApi] Unexpected workflow run shape");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") {
    throw new Error("[workflowsApi] Run missing required field (id)");
  }
  return r as unknown as WorkflowRun;
}

const httpAdapter: WorkflowsAdapter = {
  async getDefinitions(signal) {
    const data = await requestJson<WorkflowDefinitionsListResponse>(BASE, { signal });
    return { definitions: data.definitions.map(normalizeDefinition), total: data.total };
  },

  async createDefinition(input, signal) {
    return normalizeDefinition(
      await requestJson<WorkflowDefinition>(BASE, {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      })
    );
  },

  async updateDefinition(id, input, signal) {
    return normalizeDefinition(
      await requestJson<WorkflowDefinition>(`${BASE}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
        signal,
      })
    );
  },

  async deleteDefinition(id, signal) {
    await requestJson<void>(`${BASE}/${id}`, { method: "DELETE", signal });
  },

  async toggleDefinition(id, enabled, signal) {
    return normalizeDefinition(
      await requestJson<WorkflowDefinition>(`${BASE}/${id}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
        signal,
      })
    );
  },

  async launchWorkflow(definitionId, input, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/${definitionId}/launch`, {
        method: "POST",
        body: JSON.stringify(input ?? {}),
        signal,
      })
    );
  },

  async getRuns(workflowDefinitionId, signal) {
    const url = workflowDefinitionId
      ? `${BASE}/runs?workflowDefinitionId=${encodeURIComponent(workflowDefinitionId)}`
      : `${BASE}/runs`;
    const data = await requestJson<WorkflowRunsListResponse>(url, { signal });
    return { runs: data.runs.map(normalizeRun), total: data.total };
  },

  async getRun(id, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/runs/${id}`, { signal })
    );
  },

  async terminateRun(id, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/runs/${id}/terminate`, { method: "POST", signal })
    );
  },

  async resumeRun(id, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/runs/${id}/resume`, { method: "POST", signal })
    );
  },

  async restartRun(id, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/runs/${id}/restart`, { method: "POST", signal })
    );
  },

  async approveRun(id, data, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/runs/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
        signal,
      })
    );
  },

  async rejectRun(id, data, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/runs/${id}/reject`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
        signal,
      })
    );
  },

  async sendEvent(id, event, signal) {
    return normalizeRun(
      await requestJson<WorkflowRun>(`${BASE}/runs/${id}/event`, {
        method: "POST",
        body: JSON.stringify(event),
        signal,
      })
    );
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK ADAPTER
//
// Stateful in-memory implementation with seed data.  Useful during development
// when the backend is not yet returning persisted data.
//
// All mutations (create, update, delete, launch, terminate, …) are reflected
// immediately in subsequent reads without any HTTP calls.
// ═══════════════════════════════════════════════════════════════════════════════

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Seed definitions — one per workflow type to exercise all UI states.
let mockDefs: WorkflowDefinition[] = [
  {
    id: "mock-def-001",
    name: "Daily Analytics Report",
    description: "Generates and distributes a daily analytics summary to stakeholders.",
    workflowType: "report",
    triggerMode: "scheduled",
    approvalMode: "none",
    status: "active",
    entrypoint: "ANALYTICS_WORKFLOW",
    instructions: "Summarise yesterday's metrics and email the PDF to the stakeholders list.",
    inputSchemaText: JSON.stringify({ type: "object", properties: { targetDate: { type: "string" } } }, null, 2),
    enabled: true,
    tags: ["analytics", "nightly", "automated"],
    createdAt: ago(14 * 24 * 60),
    updatedAt: ago(2 * 24 * 60),
    lastRunAt: ago(60),
    runCount: 14,
  },
  {
    id: "mock-def-002",
    name: "New Customer Onboarding",
    description: "Orchestrates account setup, welcome emails, and CRM sync with an approval step.",
    workflowType: "approval",
    triggerMode: "event",
    approvalMode: "checkpoint",
    status: "active",
    entrypoint: "ONBOARDING_WORKFLOW",
    enabled: true,
    tags: ["crm", "onboarding"],
    createdAt: ago(9 * 24 * 60),
    updatedAt: ago(3 * 24 * 60),
    lastRunAt: ago(15),
    runCount: 3,
  },
  {
    id: "mock-def-003",
    name: "Staging Data Cleanup",
    description: "Purges records older than 30 days from the staging environment.",
    workflowType: "maintenance",
    triggerMode: "manual",
    approvalMode: "required",
    status: "draft",
    entrypoint: "CLEANUP_WORKFLOW",
    enabled: false,
    tags: ["maintenance", "staging"],
    createdAt: ago(6 * 24 * 60),
    updatedAt: ago(6 * 24 * 60),
    lastRunAt: null,
    runCount: 0,
  },
];

// Seed runs — one per interesting status to exercise all RunRow + inspector states.
let mockRuns: WorkflowRun[] = [
  {
    id: "mock-run-a1b2c3d4",
    workflowDefinitionId: "mock-def-002",
    workflowName: "New Customer Onboarding",
    status: "waiting",
    progressPercent: 45,
    currentStep: "Manager Approval",
    startedAt: ago(12),
    updatedAt: ago(3),
    waitingForApproval: true,
    resultSummary: null,
    errorMessage: null,
    input: { customerId: "cust-9981", tier: "enterprise" },
    steps: [
      { stepName: "Create User Record",    status: "complete", startedAt: ago(12),    completedAt: ago(11.5),  durationMs: 1_240  },
      { stepName: "Send Welcome Email",    status: "complete", startedAt: ago(11.5),  completedAt: ago(11.2),  durationMs:   820  },
      { stepName: "Provision Workspace",   status: "complete", startedAt: ago(11.2),  completedAt: ago(10.5),  durationMs: 5_800  },
      { stepName: "Manager Approval",      status: "running",  startedAt: ago(10.5)                                               },
      { stepName: "Grant System Access",   status: "pending"                                                                     },
      { stepName: "Schedule Onboarding",   status: "pending"                                                                     },
    ],
  },
  {
    id: "mock-run-e5f6a7b8",
    workflowDefinitionId: "mock-def-001",
    workflowName: "Daily Analytics Report",
    status: "running",
    progressPercent: 72,
    currentStep: "Generate PDF",
    startedAt: ago(5),
    updatedAt: ago(1),
    waitingForApproval: false,
    resultSummary: null,
    errorMessage: null,
    input: { reportDate: "2026-04-24", includeCharts: true },
    steps: [
      { stepName: "Load Configuration",  status: "complete", startedAt: ago(5),    completedAt: ago(4.98), durationMs:   310 },
      { stepName: "Query Database",      status: "complete", startedAt: ago(4.98), completedAt: ago(4.4),  durationMs: 34_800 },
      { stepName: "Aggregate Metrics",   status: "complete", startedAt: ago(4.4),  completedAt: ago(3.2),  durationMs: 72_000 },
      { stepName: "Generate PDF",        status: "running",  startedAt: ago(1)                                                },
      { stepName: "Upload to Storage",   status: "pending"                                                                    },
      { stepName: "Notify Stakeholders", status: "pending"                                                                    },
    ],
  },
  {
    id: "mock-run-c9d0e1f2",
    workflowDefinitionId: "mock-def-001",
    workflowName: "Daily Analytics Report",
    status: "complete",
    progressPercent: 100,
    startedAt: ago(25 * 60),
    updatedAt: ago(24 * 60),
    completedAt: ago(24 * 60),
    waitingForApproval: false,
    resultSummary: "Report generated — 1,240 rows processed, 0 errors.",
    errorMessage: null,
    input:  { reportDate: "2026-04-23", includeCharts: true },
    output: { reportUrl: "https://storage.example.com/reports/2026-04-23.pdf", rowCount: 1240 },
    steps: [
      { stepName: "Load Configuration",  status: "complete", startedAt: ago(25 * 60),       completedAt: ago(25 * 60 - 0.1),   durationMs:   280 },
      { stepName: "Query Database",      status: "complete", startedAt: ago(25 * 60 - 0.1), completedAt: ago(25 * 60 - 0.7),   durationMs: 36_000 },
      { stepName: "Aggregate Metrics",   status: "complete", startedAt: ago(25 * 60 - 0.7), completedAt: ago(25 * 60 - 1.7),   durationMs: 62_000 },
      { stepName: "Generate PDF",        status: "complete", startedAt: ago(25 * 60 - 1.7), completedAt: ago(25 * 60 - 2.5),   durationMs: 45_000 },
      { stepName: "Upload to Storage",   status: "complete", startedAt: ago(25 * 60 - 2.5), completedAt: ago(25 * 60 - 2.6),   durationMs:  8_200 },
      { stepName: "Notify Stakeholders", status: "complete", startedAt: ago(25 * 60 - 2.6), completedAt: ago(24 * 60),         durationMs:  1_100 },
    ],
  },
  {
    id: "mock-run-g3h4i5j6",
    workflowDefinitionId: "mock-def-002",
    workflowName: "New Customer Onboarding",
    status: "errored",
    startedAt: ago(48 * 60),
    updatedAt: ago(48 * 60 - 5),
    completedAt: ago(48 * 60 - 5),
    waitingForApproval: false,
    resultSummary: null,
    errorMessage: "CRM API timeout: POST /contacts returned 503 after 3 retries.",
    input: { customerId: "cust-7734", tier: "pro" },
    steps: [
      { stepName: "Validate Customer Data", status: "complete", startedAt: ago(48 * 60),      completedAt: ago(48 * 60 - 0.05), durationMs:  2_100 },
      { stepName: "Sync to CRM",            status: "errored",  startedAt: ago(48 * 60 - 0.05), completedAt: ago(48 * 60 - 2), durationMs: 120_000, errorMessage: "POST /contacts returned 503 after 3 retries" },
      { stepName: "Send Confirmation",      status: "skipped"                                                                                       },
      { stepName: "Assign Account Manager", status: "skipped"                                                                                       },
    ],
  },
  {
    id: "mock-run-h7i8j9k0",
    workflowDefinitionId: "mock-def-001",
    workflowName: "Daily Analytics Report",
    status: "paused",
    progressPercent: 30,
    currentStep: "Query Database",
    startedAt: ago(72 * 60),
    updatedAt: ago(71 * 60),
    waitingForApproval: false,
    resultSummary: null,
    errorMessage: null,
    steps: [
      { stepName: "Load Configuration", status: "complete", startedAt: ago(72 * 60),      completedAt: ago(72 * 60 - 0.1), durationMs:   295 },
      { stepName: "Query Database",     status: "running",  startedAt: ago(72 * 60 - 0.1)                                                   },
      { stepName: "Aggregate Metrics",  status: "pending"                                                                                    },
      { stepName: "Generate PDF",       status: "pending"                                                                                    },
      { stepName: "Upload to Storage",  status: "pending"                                                                                    },
    ],
  },
];

function mockFindDef(id: string): WorkflowDefinition {
  const def = mockDefs.find((d) => d.id === id);
  if (!def) throw new Error(`[workflowsApi/mock] Definition not found: ${id}`);
  return def;
}

function mockFindRun(id: string): WorkflowRun {
  const run = mockRuns.find((r) => r.id === id);
  if (!run) throw new Error(`[workflowsApi/mock] Run not found: ${id}`);
  return run;
}

function mockPatchRun(id: string, patch: Partial<WorkflowRun>): WorkflowRun {
  const updated = { ...mockFindRun(id), ...patch, updatedAt: new Date().toISOString() };
  mockRuns = mockRuns.map((r) => (r.id === id ? updated : r));
  return updated;
}

// Simulate async network latency.
function delay(ms = 180): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mockAdapter: WorkflowsAdapter = {
  async getDefinitions() {
    await delay();
    return { definitions: [...mockDefs], total: mockDefs.length };
  },

  async createDefinition(input) {
    await delay();
    const now = new Date().toISOString();
    const def: WorkflowDefinition = {
      ...input,
      id:           uuid(),
      triggerMode:  input.triggerMode  ?? "manual",
      approvalMode: input.approvalMode ?? "none",
      status:       input.status       ?? "active",
      enabled:      input.enabled      ?? true,
      tags:         input.tags         ?? [],
      runCount:     0,
      lastRunAt:    null,
      createdAt:    now,
      updatedAt:    now,
    };
    mockDefs = [def, ...mockDefs];
    return def;
  },

  async updateDefinition(id, input) {
    await delay();
    const updated: WorkflowDefinition = {
      ...mockFindDef(id),
      ...input,
      updatedAt: new Date().toISOString(),
    };
    mockDefs = mockDefs.map((d) => (d.id === id ? updated : d));
    return updated;
  },

  async deleteDefinition(id) {
    await delay();
    mockFindDef(id); // throws if not found
    mockDefs = mockDefs.filter((d) => d.id !== id);
  },

  async toggleDefinition(id, enabled) {
    await delay();
    const updated: WorkflowDefinition = {
      ...mockFindDef(id),
      enabled,
      updatedAt: new Date().toISOString(),
    };
    mockDefs = mockDefs.map((d) => (d.id === id ? updated : d));
    return updated;
  },

  async launchWorkflow(definitionId, input) {
    await delay(300);
    const def = mockFindDef(definitionId);
    if (!def.enabled) {
      throw new Error(`[workflowsApi/mock] Definition "${def.name}" is disabled.`);
    }
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id:                   uuid(),
      workflowDefinitionId: definitionId,
      workflowName:         def.name,
      status:               "running",
      progressPercent:      0,
      currentStep:          "initialising",
      startedAt:            now,
      updatedAt:            now,
      waitingForApproval:   false,
      resultSummary:        null,
      errorMessage:         null,
      input:                input?.input,
    };
    mockRuns = [run, ...mockRuns];
    // Update run count + lastRunAt on definition.
    mockDefs = mockDefs.map((d) =>
      d.id === definitionId
        ? { ...d, runCount: d.runCount + 1, lastRunAt: now, updatedAt: now }
        : d
    );
    return run;
  },

  async getRuns(workflowDefinitionId) {
    await delay();
    const runs = workflowDefinitionId
      ? mockRuns.filter((r) => r.workflowDefinitionId === workflowDefinitionId)
      : [...mockRuns];
    return { runs, total: runs.length };
  },

  async getRun(id) {
    await delay();
    return mockFindRun(id);
  },

  async terminateRun(id) {
    await delay();
    const now = new Date().toISOString();
    const run = mockFindRun(id);
    const active: ReadonlyArray<WorkflowRunStatus> = ["running", "waiting", "paused"];
    if (!active.includes(run.status)) {
      throw new Error(`[workflowsApi/mock] Run ${id} is already in a terminal state (${run.status}).`);
    }
    return mockPatchRun(id, { status: "terminated", completedAt: now, waitingForApproval: false });
  },

  async resumeRun(id) {
    await delay();
    const run = mockFindRun(id);
    if (run.status !== "paused") {
      throw new Error(`[workflowsApi/mock] Only paused runs can be resumed (current: ${run.status}).`);
    }
    return mockPatchRun(id, { status: "running" });
  },

  async restartRun(id) {
    await delay(300);
    const run = mockFindRun(id);
    const terminal: ReadonlyArray<WorkflowRunStatus> = ["errored", "terminated", "complete"];
    if (!terminal.includes(run.status)) {
      throw new Error(`[workflowsApi/mock] Only terminal runs can be restarted (current: ${run.status}).`);
    }
    const now = new Date().toISOString();
    return mockPatchRun(id, {
      status: "running",
      progressPercent: 0,
      currentStep: "initialising",
      startedAt: now,
      completedAt: null,
      errorMessage: null,
      resultSummary: null,
      waitingForApproval: false,
    });
  },

  async approveRun(id) {
    await delay();
    const run = mockFindRun(id);
    if (!run.waitingForApproval) {
      throw new Error(`[workflowsApi/mock] Run ${id} is not waiting for approval.`);
    }
    return mockPatchRun(id, {
      status: "running",
      waitingForApproval: false,
      currentStep: "post-approval-step",
    });
  },

  async rejectRun(id, data) {
    await delay();
    const run = mockFindRun(id);
    if (!run.waitingForApproval) {
      throw new Error(`[workflowsApi/mock] Run ${id} is not waiting for approval.`);
    }
    const now = new Date().toISOString();
    return mockPatchRun(id, {
      status: "terminated",
      waitingForApproval: false,
      completedAt: now,
      errorMessage: data?.comment
        ? `Rejected by ${data.approvedBy ?? "reviewer"}: ${data.comment}`
        : "Rejected by reviewer.",
    });
  },

  async sendEvent(id, event) {
    await delay();
    const run = mockFindRun(id);
    if (run.status !== "waiting") {
      throw new Error(`[workflowsApi/mock] Run ${id} is not in "waiting" state (current: ${run.status}).`);
    }
    return mockPatchRun(id, {
      status: "running",
      waitingForApproval: false,
      currentStep: `after-${event.eventType}`,
    });
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTER SELECTOR
//
// Set USE_MOCK = true  → all calls go to the in-memory mock adapter (fake seed data).
//     USE_MOCK = false → all calls go to the real HTTP backend (MainAgent DO via /api/workflows).
//
// The backend is ready — MainAgent has the full SQLite persistence layer and CF Workflows
// bindings wired up.  Set USE_MOCK = false when you are running `wrangler dev` or deployed
// and want to use real definitions / runs instead of the in-memory seed data.
// ═══════════════════════════════════════════════════════════════════════════════

const USE_MOCK = false; // ← flip to true to use the in-memory mock adapter

const adapter: WorkflowsAdapter = USE_MOCK ? mockAdapter : httpAdapter;

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — Definitions
// ═══════════════════════════════════════════════════════════════════════════════

/** Fetch all workflow definitions for the current session. */
export async function getWorkflowDefinitions(
  signal?: AbortSignal
): Promise<WorkflowDefinitionsListResponse> {
  return adapter.getDefinitions(signal);
}

/** Create a new workflow definition. Returns the server-assigned record. */
export async function createWorkflowDefinition(
  input: CreateWorkflowDefinitionInput,
  signal?: AbortSignal
): Promise<WorkflowDefinition> {
  return adapter.createDefinition(input, signal);
}

/** Partially update an existing definition. Returns the updated record. */
export async function updateWorkflowDefinition(
  id: string,
  input: UpdateWorkflowDefinitionInput,
  signal?: AbortSignal
): Promise<WorkflowDefinition> {
  return adapter.updateDefinition(id, input, signal);
}

/** Permanently delete a workflow definition by ID. */
export async function deleteWorkflowDefinition(
  id: string,
  signal?: AbortSignal
): Promise<void> {
  return adapter.deleteDefinition(id, signal);
}

/**
 * Enable or disable a workflow definition.
 * Convenience wrapper — equivalent to `updateWorkflowDefinition(id, { enabled })`.
 */
export async function toggleWorkflowDefinition(
  id: string,
  enabled: boolean,
  signal?: AbortSignal
): Promise<WorkflowDefinition> {
  return adapter.toggleDefinition(id, enabled, signal);
}

/**
 * Launch a new run from the given definition.
 * Returns the newly created `WorkflowRun` with status `"running"`.
 */
export async function launchWorkflow(
  definitionId: string,
  input?: LaunchWorkflowInput,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.launchWorkflow(definitionId, input, signal);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — Runs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch workflow runs, optionally filtered to a single definition.
 * Client-side filtering, search, and sorting are handled in `WorkflowsPage`.
 */
export async function getWorkflowRuns(
  workflowDefinitionId?: string,
  signal?: AbortSignal
): Promise<WorkflowRunsListResponse> {
  return adapter.getRuns(workflowDefinitionId, signal);
}

/** Fetch a single run by its Cloudflare Workflow instance ID. */
export async function getWorkflowRun(
  id: string,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.getRun(id, signal);
}

/**
 * Terminate an active run immediately.
 * Valid for runs in `"running"`, `"waiting"`, or `"paused"` state.
 * Returns the updated run with `status: "terminated"`.
 */
export async function terminateWorkflowRun(
  id: string,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.terminateRun(id, signal);
}

/**
 * Resume a paused run from where it left off.
 * Valid only for runs in `"paused"` state.
 */
export async function resumeWorkflowRun(
  id: string,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.resumeRun(id, signal);
}

/**
 * Restart a terminal run from the beginning.
 * Valid for runs in `"errored"`, `"terminated"`, or `"complete"` state.
 * Returns the run with status reset to `"running"`.
 */
export async function restartWorkflowRun(
  id: string,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.restartRun(id, signal);
}

/**
 * Approve a run that is `waitingForApproval`.
 * The run resumes execution past the approval checkpoint.
 */
export async function approveWorkflowRun(
  id: string,
  data?: WorkflowApprovalData,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.approveRun(id, data, signal);
}

/**
 * Reject a run that is `waitingForApproval`.
 * The run is terminated with an error message containing the rejection comment.
 */
export async function rejectWorkflowRun(
  id: string,
  data?: WorkflowApprovalData,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.rejectRun(id, data, signal);
}

/**
 * Send an external event to a run in `"waiting"` state.
 * The workflow resumes execution on the named event trigger.
 */
export async function sendWorkflowEvent(
  id: string,
  event: WorkflowEventPayload,
  signal?: AbortSignal
): Promise<WorkflowRun> {
  return adapter.sendEvent(id, event, signal);
}

/**
 * Return the binding names of every CF Workflow class registered in the
 * worker's environment (e.g. ["EDGECLAW_RESEARCH_WORKFLOW"]).
 *
 * Used to populate the entrypoint dropdown when creating / editing a
 * workflow definition.  The list is sourced at runtime from the worker env,
 * so new workflows appear automatically after the next deploy — no frontend
 * change needed.
 */
export async function fetchWorkflowBindings(signal?: AbortSignal): Promise<string[]> {
  if (USE_MOCK) return ["EDGECLAW_PAGE_INTEL_WORKFLOW", "EDGECLAW_RESEARCH_WORKFLOW"];
  const data = await requestJson<{ bindings: string[] }>(`${BASE}/bindings`, { signal });
  return data.bindings;
}
