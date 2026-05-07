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

export interface CoordinatorFinalizeResponse {
  ok: boolean;
  readiness: { ok: boolean; reasons: string[] };
  manifest: Record<string, unknown>;
  sharedProjectId?: string;
  manifestPersistPath: string | null;
}

/** Review-only: builds a promotion-prep manifest from applied patches + blueprint docs (never deploys). */
export async function postCoordinatorProjectFinalize(
  projectId: string,
  body: { persistManifest: boolean; operatorAcknowledgesHumanReviewRequired: boolean },
  signal?: AbortSignal
): Promise<CoordinatorFinalizeResponse> {
  return requestJson(`/api/coordinator/projects/${encodeURIComponent(projectId)}/finalize`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

/** Prefix remap for materialized paths (e.g. `staging/` → `db/`). */
export interface CoordinatorPathMappingRule {
  fromPrefix: string;
  toPrefix: string;
  /** Exact full-path match when true (server-side materialize). */
  exact?: boolean;
}

/** Built-in mapping modes for materialize (server resolves to concrete rules). */
export type CoordinatorMaterializeMappingPreset = "none" | "simple_staging" | "team_task_tracker";

export interface CoordinatorMaterializePreviewRow {
  sourcePath: string;
  destinationPath: string;
  patchId: string;
  status: "applied" | "conflict" | "skipped";
  detail?: string;
}

export interface CoordinatorMaterializeReportPayload {
  generatedAt: string;
  mapping: { preset: string; rules: CoordinatorPathMappingRule[] };
  previewRows: CoordinatorMaterializePreviewRow[];
  conflicts: Array<{ patchId: string; path: string; detail: string }>;
  skipped: Array<{ patchId: string; path?: string; reason: string }>;
  patchCount: number;
  fileCount: number;
}

export interface CoordinatorMaterializePreviewResponse extends CoordinatorMaterializeReportPayload {
  ok: true;
  sharedProjectId: string;
  format: "preview";
}

export interface CoordinatorMaterializeJsonResponse extends CoordinatorMaterializeReportPayload {
  ok: true;
  sharedProjectId: string;
  format: "json";
  files: Record<string, string>;
}

export async function postCoordinatorProjectMaterializePreview(
  projectId: string,
  body: { mappingPreset?: CoordinatorMaterializeMappingPreset },
  signal?: AbortSignal
): Promise<CoordinatorMaterializePreviewResponse> {
  return requestJson(`/api/coordinator/projects/${encodeURIComponent(projectId)}/materialize`, {
    method: "POST",
    body: JSON.stringify({ format: "preview", mappingPreset: body.mappingPreset ?? "none" }),
    signal,
  });
}

/** Reconstruct applied patches into a ZIP (stored mode). Includes `MATERIALIZE_REPORT.json`. */
export async function postCoordinatorProjectMaterializeZip(
  projectId: string,
  body: { mappingPreset?: CoordinatorMaterializeMappingPreset; pathMappings?: CoordinatorPathMappingRule[] },
  signal?: AbortSignal
): Promise<Blob> {
  const res = await fetch(`/api/coordinator/projects/${encodeURIComponent(projectId)}/materialize`, {
    method: "POST",
    headers: {
      Accept: "application/zip",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      format: "zip",
      mappingPreset: body.mappingPreset ?? "none",
      ...(body.pathMappings?.length ? { pathMappings: body.pathMappings } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let err = text || res.statusText;
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (j && typeof j.error === "string" && j.error.trim()) err = j.error.trim();
    } catch {
      /* keep text */
    }
    throw new Error(`[coordinatorControlPlaneApi] ${res.status} — ${err}`);
  }
  return res.blob();
}

/** Same merge as ZIP but returns paths → contents + conflict report (no binary files). */
export async function postCoordinatorProjectMaterializeJson(
  projectId: string,
  body: { mappingPreset?: CoordinatorMaterializeMappingPreset; pathMappings?: CoordinatorPathMappingRule[] },
  signal?: AbortSignal
): Promise<CoordinatorMaterializeJsonResponse> {
  return requestJson(`/api/coordinator/projects/${encodeURIComponent(projectId)}/materialize`, {
    method: "POST",
    body: JSON.stringify({
      format: "json",
      mappingPreset: body.mappingPreset ?? "none",
      ...(body.pathMappings?.length ? { pathMappings: body.pathMappings } : {}),
    }),
    signal,
  });
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

/** Rollup from Worker AI Gateway log aggregation (metadata filter + pagination). */
export type CoordinatorAiGatewayRollup =
  | {
      ok: true;
      tokensIn: number;
      tokensOut: number;
      totalCost: number;
      entryCount: number;
      truncated: boolean;
      pagesFetched: number;
    }
  | { ok: false; error: string; hint?: string };

export type CoordinatorProjectGatewayUsageBatchResponse = {
  ok: true;
  version?: number;
  maxPagesPerProject: number;
  projects: Record<string, CoordinatorAiGatewayRollup>;
};

export type CoordinatorSubagentGatewayUsageResponse = {
  ok: true;
  version?: number;
  maxPages: number;
  CoderAgent: CoordinatorAiGatewayRollup;
  TesterAgent: CoordinatorAiGatewayRollup;
};

async function parseJsonResponse<T>(res: Response, fallback: T): Promise<T> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Sum AI Gateway usage for many control-plane projects (`metadata.project` on gateway requests). */
export async function getCoordinatorProjectGatewayUsageBatch(
  projectIds: readonly string[],
  options?: { maxPages?: number; signal?: AbortSignal }
): Promise<
  CoordinatorProjectGatewayUsageBatchResponse | { ok: false; error: string }
> {
  const ids = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { ok: true, maxPagesPerProject: 0, projects: {} };
  }
  const q = new URLSearchParams({ ids: ids.join(",") });
  if (options?.maxPages != null) {
    q.set("maxPages", String(Math.min(100, Math.max(1, options.maxPages))));
  }
  const res = await fetch(`/api/coordinator/ai-gateway/project-usage?${q}`, {
    signal: options?.signal,
    headers: { Accept: "application/json" },
  });
  const body = await parseJsonResponse<unknown>(res, null);
  if (!res.ok) {
    const err =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error?: unknown }).error)
        : `HTTP ${res.status}`;
    return { ok: false, error: err };
  }
  if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
    return { ok: false, error: "Unexpected project-usage response" };
  }
  const b = body as CoordinatorProjectGatewayUsageBatchResponse;
  return {
    ok: true,
    version: b.version,
    maxPagesPerProject:
      typeof b.maxPagesPerProject === "number" ? b.maxPagesPerProject : 30,
    projects: typeof b.projects === "object" && b.projects !== null ? b.projects : {},
  };
}

/** Totals for sub-agent DO classes via `metadata.agent` on AI Gateway (CoderAgent, TesterAgent). */
export async function getCoordinatorSubagentGatewayUsage(
  options?: { maxPages?: number; signal?: AbortSignal }
): Promise<
  CoordinatorSubagentGatewayUsageResponse | { ok: false; error: string }
> {
  const q = new URLSearchParams();
  if (options?.maxPages != null) {
    q.set("maxPages", String(Math.min(100, Math.max(1, options.maxPages))));
  }
  const url = `/api/coordinator/ai-gateway/subagent-usage${q.toString() ? `?${q}` : ""}`;
  const res = await fetch(url, {
    signal: options?.signal,
    headers: { Accept: "application/json" },
  });
  const body = await parseJsonResponse<unknown>(res, null);
  if (!res.ok) {
    const err =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error?: unknown }).error)
        : `HTTP ${res.status}`;
    return { ok: false, error: err };
  }
  if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
    return { ok: false, error: "Unexpected subagent-usage response" };
  }
  return body as CoordinatorSubagentGatewayUsageResponse;
}

/** Proxied Cloudflare AI Gateway list logs filtered by metadata `run` = control-plane run id. */
export async function getCoordinatorAiGatewayRunLogs(
  runId: string,
  limit = 50,
  signal?: AbortSignal
): Promise<CoordinatorAiGatewayRunLogsResponse> {
  const q = new URLSearchParams({ limit: String(Math.min(50, Math.max(1, limit))) });
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
