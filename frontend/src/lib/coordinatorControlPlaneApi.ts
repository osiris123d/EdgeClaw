/**
 * API client for `/api/coordinator/*` (Worker control plane — not MainAgent DO).
 */

export type {
  BlueprintDocSourceState,
  BlueprintFileKey,
  CoordinatorProject,
  CoordinatorTask,
  CoordinatorTaskRole,
  CoordinatorTaskStatus,
  CoordinatorReviewDecision,
  CoordinatorReviewReasonCategory,
  CoordinatorRun,
  CoordinatorRunSource,
  CoordinatorRunIterationSummary,
  ProjectBlueprint,
  ProjectReadiness,
} from "../types/coordinatorControlPlane";

import type {
  BlueprintFileKey,
  CoordinatorProject,
  CoordinatorTask,
  CoordinatorRun,
  ProjectBlueprint,
} from "../types/coordinatorControlPlane";

/** Create payload — server assigns \`readiness\` from blueprint validation. */
export type NewCoordinatorProjectInput = Omit<
  CoordinatorProject,
  "createdAt" | "updatedAt" | "readiness" | "validationErrors" | "title"
> & { title?: string };

export interface CoordinatorHealthResponse {
  ok: true;
  environmentName: string;
  subagentCoordinatorBindingPresent: boolean;
  debugOrchestrationEndpointEnabled: boolean;
  debugOrchestrationTokenConfigured: boolean;
  sharedWorkspaceKvPresent: boolean;
  controlPlaneKvPresent: boolean;
  promotionArtifactWriterBranch: string;
  hasArtifactPromotionPersistence: boolean;
  flagshipEvaluationBranch: string;
  lastCoordinatorChain: {
    completedAtIso: string;
    session: string;
    httpStatus: number;
  } | null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error?: unknown }).error)
        : text || res.statusText;
    throw new Error(`[coordinatorControlPlaneApi] ${res.status} — ${err}`);
  }
  if (res.status === 204) return undefined as T;
  return body as T;
}

export async function getCoordinatorHealth(signal?: AbortSignal): Promise<CoordinatorHealthResponse> {
  return requestJson<CoordinatorHealthResponse>("/api/coordinator/health", { signal });
}

export async function listCoordinatorProjects(signal?: AbortSignal): Promise<{
  projects: CoordinatorProject[];
  storageAvailable: boolean;
}> {
  return requestJson("/api/coordinator/projects", { signal });
}

export async function getCoordinatorProject(
  projectId: string,
  signal?: AbortSignal
): Promise<{ project: CoordinatorProject; storageAvailable: boolean }> {
  return requestJson(`/api/coordinator/projects/${encodeURIComponent(projectId)}`, { signal });
}

export interface CoordinatorWorkspacePatchListItem {
  patchId: string;
  status: string;
}

export async function listCoordinatorProjectWorkspacePatches(
  projectId: string,
  signal?: AbortSignal
): Promise<{ sharedProjectId: string; patches: CoordinatorWorkspacePatchListItem[] }> {
  return requestJson(`/api/coordinator/projects/${encodeURIComponent(projectId)}/workspace/patches`, { signal });
}

export async function getCoordinatorProjectWorkspacePatch(
  projectId: string,
  patchId: string,
  signal?: AbortSignal
): Promise<{
  sharedProjectId: string;
  patchId: string;
  record: { status: string; body: string; updatedAt: string; rejectReason?: string };
}> {
  return requestJson(
    `/api/coordinator/projects/${encodeURIComponent(projectId)}/workspace/patches/${encodeURIComponent(patchId)}`,
    { signal }
  );
}

export async function postCoordinatorBlueprintTemplates(
  body: { projectName: string; projectSlug: string; only?: BlueprintFileKey },
  signal?: AbortSignal
): Promise<{ blueprint: ProjectBlueprint; partial: boolean }> {
  return requestJson("/api/coordinator/blueprint-templates", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

export async function createCoordinatorProject(
  input: NewCoordinatorProjectInput,
  signal?: AbortSignal
): Promise<CoordinatorProject> {
  return requestJson("/api/coordinator/projects", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

export async function patchCoordinatorProject(
  id: string,
  patch: Partial<Omit<CoordinatorProject, "projectId" | "createdAt">>,
  signal?: AbortSignal
): Promise<CoordinatorProject> {
  return requestJson(`/api/coordinator/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    signal,
  });
}

export async function deleteCoordinatorProject(id: string, signal?: AbortSignal): Promise<void> {
  await requestJson(`/api/coordinator/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal,
  });
}

export interface RoadmapImportResponse {
  ok: boolean;
  created: number;
  updated: number;
  skipped: number;
  warnings: string[];
  touchedTaskIds: string[];
  error?: string;
}

/** Upsert tasks from the project's blueprint `ROADMAP.md` (idempotent). */
export async function postImportCoordinatorRoadmap(
  projectId: string,
  signal?: AbortSignal
): Promise<RoadmapImportResponse> {
  return requestJson(`/api/coordinator/projects/${encodeURIComponent(projectId)}/import-roadmap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
}

export async function listCoordinatorTasks(
  projectId: string,
  signal?: AbortSignal
): Promise<{ tasks: CoordinatorTask[]; storageAvailable: boolean }> {
  const q = new URLSearchParams({ projectId });
  return requestJson(`/api/coordinator/tasks?${q}`, { signal });
}

export async function createCoordinatorTask(
  input: Omit<CoordinatorTask, "createdAt" | "updatedAt">,
  signal?: AbortSignal
): Promise<CoordinatorTask> {
  return requestJson("/api/coordinator/tasks", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

export async function patchCoordinatorTask(
  id: string,
  patch: Partial<Omit<CoordinatorTask, "taskId" | "createdAt">>,
  signal?: AbortSignal
): Promise<CoordinatorTask> {
  return requestJson(`/api/coordinator/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    signal,
  });
}

export async function deleteCoordinatorTask(id: string, signal?: AbortSignal): Promise<void> {
  await requestJson(`/api/coordinator/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal,
  });
}

export async function listCoordinatorRuns(
  limit?: number,
  signal?: AbortSignal
): Promise<{ runs: CoordinatorRun[]; storageAvailable: boolean }> {
  const q = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return requestJson(`/api/coordinator/runs${q}`, { signal });
}

export async function appendCoordinatorRun(
  run: CoordinatorRun,
  signal?: AbortSignal
): Promise<CoordinatorRun> {
  return requestJson("/api/coordinator/runs", {
    method: "POST",
    body: JSON.stringify(run),
    signal,
  });
}

export async function patchCoordinatorRun(
  runId: string,
  patch: Partial<Omit<CoordinatorRun, "runId">>,
  signal?: AbortSignal
): Promise<CoordinatorRun> {
  return requestJson(`/api/coordinator/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    signal,
  });
}

export interface CoordinatorAiGatewayLogEntry {
  id: string;
  created_at: string;
  model: string;
  provider: string;
  success: boolean;
  tokens_in: number;
  tokens_out: number;
  cost?: number;
  metadata?: string;
}

export type CoordinatorAiGatewayRunLogsResponse =
  | {
      ok: true;
      runId: string;
      totalCost: number;
      tokensIn: number;
      tokensOut: number;
      entryCount: number;
      entries: CoordinatorAiGatewayLogEntry[];
      version?: number;
    }
  | {
      ok: false;
      runId: string;
      error: string;
      hint?: string;
      version?: number;
    };

/** Proxied Cloudflare AI Gateway list logs filtered by metadata `run` = control-plane run id. */
export async function getCoordinatorAiGatewayRunLogs(
  runId: string,
  limit = 50,
  signal?: AbortSignal
): Promise<CoordinatorAiGatewayRunLogsResponse> {
  const q = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, limit))) });
  const res = await fetch(
    `/api/coordinator/ai-gateway/runs/${encodeURIComponent(runId)}/logs?${q}`,
    { signal, headers: { Accept: "application/json" } }
  );
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = { ok: false, runId, error: "Invalid JSON from coordinator" };
  }
  const parsed = (body && typeof body === "object" ? body : {}) as CoordinatorAiGatewayRunLogsResponse;
  if (typeof (parsed as { ok?: unknown }).ok === "boolean") {
    return parsed as CoordinatorAiGatewayRunLogsResponse;
  }
  return {
    ok: false,
    runId,
    error: res.ok ? "Unexpected response" : `HTTP ${res.status}: ${text.slice(0, 240)}`,
  };
}
