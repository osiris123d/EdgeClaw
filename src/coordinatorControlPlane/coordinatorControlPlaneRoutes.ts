import type { Env } from "../lib/env";
import { buildCoordinatorHealthSnapshot } from "./coordinatorHealth";
import {
  appendRun,
  controlPlaneStorageAvailable,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getProject,
  importRoadmapTasksForProject,
  listProjects,
  listRuns,
  listTasksForProject,
  patchCoordinatorRun,
  updateProject,
  updateTask,
} from "./coordinatorControlPlaneStore";
import { buildGeneratedTemplateBlueprint } from "./blueprintTemplateGenerators";
import { slugifyProjectName } from "./projectSlug";
import { getSharedWorkspaceGateway } from "../workspace/sharedWorkspaceFactory";
import {
  AI_GATEWAY_LOG_QUERY_VERSION,
  queryAiGatewayLogsForRun,
} from "../observability/aiGatewayLogQuery";
import type {
  BlueprintFileKey,
  CoordinatorProject,
  CoordinatorRun,
  CoordinatorTask,
  ProjectBlueprint,
} from "./types";
import { BLUEPRINT_FILE_KEYS } from "./types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function storageRequired(): Response {
  return json(
    {
      error: "Control-plane storage is not configured.",
      hint: "Bind COORDINATOR_CONTROL_PLANE_KV in wrangler.jsonc (KV namespace) to enable projects, tasks, and run history persistence.",
    },
    503
  );
}

/** Strip `/api/coordinator` prefix; `pathname` is full URL path. */
function restPath(pathname: string): string {
  const base = "/api/coordinator";
  if (pathname === base || pathname === `${base}/`) return "";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length + 1);
  return pathname;
}

function segments(rest: string): string[] {
  return rest.split("/").filter(Boolean);
}

/**
 * HTTP router for `/api/coordinator/*` — Worker-local (not proxied to MainAgent DO).
 */
export async function handleCoordinatorControlPlaneRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const rest = restPath(url.pathname);
  const seg = segments(rest);

  try {
    if (seg[0] === "health" && (seg.length === 1 || seg[1] === "") && request.method === "GET") {
      const snapshot = await buildCoordinatorHealthSnapshot(env);
      return json({ ok: true, ...snapshot });
    }

    if (seg[0] === "blueprint-templates" && seg.length === 1 && request.method === "POST") {
      const body = (await request.json()) as { projectName?: string; projectSlug?: string; only?: string };
      const name = (body.projectName ?? "").trim() || "Untitled project";
      const slug = (body.projectSlug ?? "").trim();
      const only =
        typeof body.only === "string" && (BLUEPRINT_FILE_KEYS as readonly string[]).includes(body.only)
          ? (body.only as BlueprintFileKey)
          : undefined;
      const blueprint = buildGeneratedTemplateBlueprint(name, slug, only);
      return json({ blueprint, partial: Boolean(only) });
    }

    if (seg[0] === "projects" && seg.length === 1 && request.method === "GET") {
      const projects = await listProjects(env);
      return json({
        projects,
        storageAvailable: controlPlaneStorageAvailable(env),
      });
    }

    if (seg[0] === "projects" && seg.length === 2 && request.method === "GET") {
      const projectId = seg[1];
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const project = await getProject(env, projectId);
      if (!project) return json({ error: "Project not found" }, 404);
      return json({ project, storageAvailable: controlPlaneStorageAvailable(env) });
    }

    if (
      seg[0] === "projects" &&
      seg.length === 5 &&
      seg[2] === "workspace" &&
      seg[3] === "patches" &&
      request.method === "GET"
    ) {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const projectId = seg[1]!;
      const patchId = seg[4]!;
      const project = await getProject(env, projectId);
      if (!project) return json({ error: "Project not found" }, 404);
      const gateway = getSharedWorkspaceGateway(env);
      if (!gateway) {
        return json(
          {
            error: "Shared workspace KV is not bound.",
            hint: "Bind SHARED_WORKSPACE_KV in wrangler.jsonc to inspect patch proposals from the control plane.",
            storageAvailable: false,
          },
          503
        );
      }
      const sharedProjectId = project.sharedProjectId.trim();
      const got = await gateway.getPatchProposal("orchestrator", sharedProjectId, patchId);
      if ("error" in got) {
        return json({ error: got.error, sharedProjectId, patchId }, 404);
      }
      return json({ sharedProjectId, patchId, record: got.record });
    }

    if (seg[0] === "projects" && seg.length === 4 && seg[2] === "workspace" && seg[3] === "patches" && request.method === "GET") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const projectId = seg[1]!;
      const project = await getProject(env, projectId);
      if (!project) return json({ error: "Project not found" }, 404);
      const gateway = getSharedWorkspaceGateway(env);
      if (!gateway) {
        return json(
          {
            error: "Shared workspace KV is not bound.",
            hint: "Bind SHARED_WORKSPACE_KV in wrangler.jsonc to list patch proposals from the control plane.",
            storageAvailable: false,
          },
          503
        );
      }
      const sharedProjectId = project.sharedProjectId.trim();
      const listed = await gateway.listPatchProposals("orchestrator", sharedProjectId);
      if ("error" in listed) {
        return json({ error: listed.error, sharedProjectId }, 500);
      }
      return json({ sharedProjectId, patches: listed.patches });
    }

    if (seg[0] === "projects" && seg.length === 1 && request.method === "POST") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const body = (await request.json()) as Partial<CoordinatorProject> & { title?: string };
      const projectName = (body.projectName ?? body.title ?? "").trim();
      if (!body.projectId?.trim() || !projectName || !body.sharedProjectId?.trim()) {
        return json(
          { error: "projectId, projectName (or legacy title), and sharedProjectId are required" },
          400
        );
      }
      const blueprint: ProjectBlueprint =
        body.blueprint && typeof body.blueprint === "object"
          ? (body.blueprint as ProjectBlueprint)
          : { schemaVersion: 1, docs: {} };
      const projectSlug = (body.projectSlug?.trim() || slugifyProjectName(projectName)).trim();
      const row = await createProject(env, {
        projectId: body.projectId.trim(),
        projectName,
        projectSlug,
        description: (body.description ?? "").trim(),
        specPath: (body.specPath ?? "").trim(),
        sharedProjectId: body.sharedProjectId.trim(),
        status: body.status === "archived" ? "archived" : "active",
        blueprint,
        allowedScopeDirs: Array.isArray(body.allowedScopeDirs)
          ? body.allowedScopeDirs.filter((d): d is string => typeof d === "string")
          : [],
      });
      return json(row, 201);
    }

    if (seg[0] === "projects" && seg.length === 3 && seg[2] === "import-roadmap" && request.method === "POST") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const projectId = seg[1]!;
      const result = await importRoadmapTasksForProject(env, projectId);
      if (!result.ok) {
        return json(
          {
            ok: false,
            error: result.error ?? "Import failed",
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            warnings: result.warnings,
            touchedTaskIds: result.touchedTaskIds,
          },
          404
        );
      }
      return json(result, 200);
    }

    if (seg[0] === "projects" && seg.length === 2 && request.method === "PATCH") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const projectId = seg[1];
      const body = (await request.json()) as Partial<CoordinatorProject>;
      const updated = await updateProject(env, projectId, body);
      return json(updated);
    }

    if (seg[0] === "projects" && seg.length === 2 && request.method === "DELETE") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      await deleteProject(env, seg[1]);
      return new Response(null, { status: 204 });
    }

    if (seg[0] === "tasks" && seg.length === 1 && request.method === "GET") {
      const projectId = url.searchParams.get("projectId")?.trim();
      if (!projectId) {
        return json({ error: "Query projectId is required" }, 400);
      }
      const tasks = await listTasksForProject(env, projectId);
      return json({
        tasks,
        storageAvailable: controlPlaneStorageAvailable(env),
      });
    }

    if (seg[0] === "tasks" && seg.length === 1 && request.method === "POST") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const body = (await request.json()) as Partial<CoordinatorTask>;
      if (!body.taskId?.trim() || !body.projectId?.trim() || !body.title?.trim()) {
        return json({ error: "taskId, projectId, and title are required" }, 400);
      }
      const role =
        body.assignedRole === "coder" || body.assignedRole === "tester" || body.assignedRole === "coordinator"
          ? body.assignedRole
          : "coordinator";
      const st =
        body.status === "todo" ||
        body.status === "in_progress" ||
        body.status === "blocked" ||
        body.status === "review" ||
        body.status === "done"
          ? body.status
          : "todo";
      const taskSource =
        body.taskSource === "roadmap" ||
        body.taskSource === "manual" ||
        body.taskSource === "coordinator_generated" ||
        body.taskSource === "tester_generated" ||
        body.taskSource === "mainagent_generated"
          ? body.taskSource
          : undefined;
      const dependsOnTaskIds = Array.isArray(body.dependsOnTaskIds)
        ? body.dependsOnTaskIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
        : undefined;
      const row = await createTask(env, {
        taskId: body.taskId.trim(),
        projectId: body.projectId.trim(),
        title: body.title.trim(),
        description: (body.description ?? "").trim(),
        assignedRole: role,
        status: st,
        acceptanceCriteria: (body.acceptanceCriteria ?? "").trim(),
        lastRunId: typeof body.lastRunId === "string" ? body.lastRunId : undefined,
        ...(taskSource ? { taskSource } : {}),
        ...(dependsOnTaskIds?.length ? { dependsOnTaskIds } : {}),
        ...(typeof body.sourceFingerprint === "string" && body.sourceFingerprint.trim()
          ? { sourceFingerprint: body.sourceFingerprint.trim() }
          : {}),
        ...(body.importedFromRoadmap === true ? { importedFromRoadmap: true } : {}),
        ...(typeof body.parentTaskId === "string" && body.parentTaskId.trim()
          ? { parentTaskId: body.parentTaskId.trim() }
          : {}),
      });
      return json(row, 201);
    }

    if (seg[0] === "tasks" && seg.length === 2 && request.method === "PATCH") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const body = (await request.json()) as Partial<CoordinatorTask>;
      const hadReview = Boolean(
        body.reviewDecision === "approved" ||
          body.reviewDecision === "needs_revision" ||
          body.reviewDecision === "blocked"
      );
      if (hadReview) {
        console.info(
          "review_decision_saved",
          JSON.stringify({
            taskId: seg[1],
            reviewDecision: body.reviewDecision ?? null,
            reviewReasonCategory: body.reviewReasonCategory ?? null,
            hasNote: Boolean(
              typeof body.reviewDecisionNote === "string" && body.reviewDecisionNote.trim().length > 0
            ),
            hasOperatorRevision:
              typeof body.operatorRevisionNote === "string" && body.operatorRevisionNote.trim().length > 0,
            status: body.status ?? null,
          })
        );
      }
      const updated = await updateTask(env, seg[1], body);
      if (hadReview) {
        console.info(
          "review_decision_applied",
          JSON.stringify({
            taskId: updated.taskId,
            reviewDecision: updated.reviewDecision ?? null,
            reviewReasonCategory: updated.reviewReasonCategory ?? null,
            reviewedAt: updated.reviewedAt ?? null,
            status: updated.status,
          })
        );
      }
      return json(updated);
    }

    if (seg[0] === "tasks" && seg.length === 2 && request.method === "DELETE") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      await deleteTask(env, seg[1]);
      return new Response(null, { status: 204 });
    }

    if (
      seg[0] === "ai-gateway" &&
      seg[1] === "runs" &&
      seg.length === 4 &&
      seg[3] === "logs" &&
      request.method === "GET"
    ) {
      const runId = seg[2]!;
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const out = await queryAiGatewayLogsForRun(env, runId, { limit });
      if (!out.ok) {
        return json({ ...out, version: AI_GATEWAY_LOG_QUERY_VERSION }, 503);
      }
      return json({ ...out, version: AI_GATEWAY_LOG_QUERY_VERSION });
    }

    if (seg[0] === "runs" && seg.length === 1 && request.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const runs = await listRuns(env, limit);
      return json({
        runs,
        storageAvailable: controlPlaneStorageAvailable(env),
      });
    }

    if (seg[0] === "runs" && seg.length === 1 && request.method === "POST") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const body = (await request.json()) as Partial<CoordinatorRun>;
      if (!body.runId?.trim() || !body.projectId?.trim() || !body.sessionId?.trim()) {
        return json({ error: "runId, projectId, and sessionId are required" }, 400);
      }
      const source =
        body.source === "debug_http_coordinator_chain" ||
        body.source === "debug_http_delegated_ping" ||
        body.source === "debug_rpc_orchestrate" ||
        body.source === "manual"
          ? body.source
          : "debug_http_orchestrate";
      const row: CoordinatorRun = {
        runId: body.runId.trim(),
        projectId: body.projectId.trim(),
        ...(typeof body.taskId === "string" && body.taskId.trim() ? { taskId: body.taskId.trim() } : {}),
        sessionId: body.sessionId.trim(),
        source,
        startedAt: (body.startedAt ?? new Date().toISOString()).trim(),
        finishedAt: typeof body.finishedAt === "string" ? body.finishedAt : undefined,
        finalStatus: typeof body.finalStatus === "string" ? body.finalStatus : undefined,
        loopTerminalStatus: typeof body.loopTerminalStatus === "string" ? body.loopTerminalStatus : undefined,
        runLifecycleStatus:
          body.runLifecycleStatus === "running" || body.runLifecycleStatus === "completed"
            ? body.runLifecycleStatus
            : undefined,
        iterationCount: typeof body.iterationCount === "number" ? body.iterationCount : undefined,
        patchIds: Array.isArray(body.patchIds) ? body.patchIds.filter((p): p is string => typeof p === "string") : undefined,
        verdictSummary: typeof body.verdictSummary === "string" ? body.verdictSummary : undefined,
        coordinatorPathUsed: typeof body.coordinatorPathUsed === "boolean" ? body.coordinatorPathUsed : undefined,
        blueprintContextLoaded:
          typeof body.blueprintContextLoaded === "boolean" ? body.blueprintContextLoaded : undefined,
        blueprintContextAssembly:
          body.blueprintContextAssembly === "task_scoped" ||
          body.blueprintContextAssembly === "full_fallback" ||
          body.blueprintContextAssembly === "preformatted" ||
          body.blueprintContextAssembly === null
            ? body.blueprintContextAssembly
            : undefined,
        iterationSummaries: Array.isArray(body.iterationSummaries) ? body.iterationSummaries : undefined,
        ...(typeof body.summaryForUser === "string" ? { summaryForUser: body.summaryForUser } : {}),
        ...(Array.isArray(body.iterationEvidence)
          ? { iterationEvidence: body.iterationEvidence as NonNullable<CoordinatorRun["iterationEvidence"]> }
          : {}),
        ...(Array.isArray(body.subagentTurnAudit)
          ? {
              subagentTurnAudit: body.subagentTurnAudit as NonNullable<CoordinatorRun["subagentTurnAudit"]>,
            }
          : {}),
        ...(Array.isArray(body.followUpTaskIds)
          ? {
              followUpTaskIds: body.followUpTaskIds.filter(
                (id): id is string => typeof id === "string" && id.trim().length > 0
              ),
            }
          : {}),
      };
      const created = await appendRun(env, row);
      return json(created, 201);
    }

    if (seg[0] === "runs" && seg.length === 2 && request.method === "PATCH") {
      if (!controlPlaneStorageAvailable(env)) return storageRequired();
      const body = (await request.json()) as Partial<Omit<CoordinatorRun, "runId">>;
      const updated = await patchCoordinatorRun(env, seg[1]!, body);
      return json(updated);
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 400);
  }
}
