/**
 * Load + format control-plane project blueprints for coordinator-led runs.
 * Future: swap {@link formatBlueprintContextForPrompt} for task-scoped slices without changing {@link ProjectBlueprintContextPackage}.
 */

import type { Env } from "../lib/env";
import { getProject } from "./coordinatorControlPlaneStore";
import type { CoordinatorProject, CoordinatorTask, ProjectReadiness } from "./types";

/** Structured context for coordinator / coder / tester (plain JSON). */
export interface ProjectBlueprintContextPackage {
  projectId: string;
  projectName: string;
  projectSlug: string;
  sharedProjectId: string;
  readiness: ProjectReadiness;
  validationErrors?: string[];
  blueprint: {
    projectSpec: string;
    roadmap: string;
    dataModels: string;
    apiDesign: string;
    aiInstructions: string;
    context: string;
    fileStructure: string;
  };
}

export class OrchestrationBlueprintError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "OrchestrationBlueprintError";
    this.statusCode = statusCode;
  }
}

const RUNNABLE_TASK_STATUSES = new Set<CoordinatorTask["status"]>(["todo", "in_progress", "review"]);

/**
 * Ensures a control-plane task exists, belongs to the orchestration project, and may start a run.
 * @throws {@link OrchestrationBlueprintError} with 404 / 400
 */
export function assertTaskRunnableForProject(
  task: CoordinatorTask | null | undefined,
  expectedProjectId: string
): CoordinatorTask {
  const expect = expectedProjectId.trim();
  if (!task) {
    throw new OrchestrationBlueprintError("Control-plane task not found.", 404);
  }
  if (task.projectId !== expect) {
    throw new OrchestrationBlueprintError(
      `Task ${task.taskId} does not belong to project ${expect}.`,
      400
    );
  }
  if (!RUNNABLE_TASK_STATUSES.has(task.status)) {
    throw new OrchestrationBlueprintError(
      `Task is not runnable for orchestration (status=${task.status}; allowed: todo, in_progress, review).`,
      400
    );
  }
  return task;
}

export function buildContextPackageFromProject(project: CoordinatorProject): ProjectBlueprintContextPackage {
  const d = project.blueprint?.docs ?? {};
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    projectSlug: project.projectSlug,
    sharedProjectId: project.sharedProjectId,
    readiness: project.readiness,
    validationErrors: project.validationErrors,
    blueprint: {
      projectSpec: d["PROJECT_SPEC.md"] ?? "",
      roadmap: d["ROADMAP.md"] ?? "",
      dataModels: d["DATA_MODELS.md"] ?? "",
      apiDesign: d["API_DESIGN.md"] ?? "",
      aiInstructions: d["AI_INSTRUCTIONS.md"] ?? "",
      context: d["CONTEXT.md"] ?? "",
      fileStructure: d["FILE_STRUCTURE.md"] ?? "",
    },
  };
}

const MAX_CONTEXT_CHARS = 28_000;

/**
 * Single markdown block for injection into coder/tester prompts.
 * Used by {@link assembleBlueprintContextForCodingTask} as full-doc fallback; for direct callers prefer
 * passing {@link ProjectBlueprintContextPackage} into the coding loop and letting the loop assemble task-scoped context.
 */
export function formatBlueprintContextForPrompt(pkg: ProjectBlueprintContextPackage): string {
  const sections: string[] = [
    "## Project identity",
    `- **projectId (control plane):** ${pkg.projectId}`,
    `- **projectName:** ${pkg.projectName}`,
    `- **projectSlug:** ${pkg.projectSlug}`,
    `- **sharedProjectId (workspace):** ${pkg.sharedProjectId}`,
    `- **readiness:** ${pkg.readiness}`,
    "",
    "## PROJECT_SPEC.md",
    pkg.blueprint.projectSpec.trim() || "(empty)",
    "",
    "## ROADMAP.md",
    pkg.blueprint.roadmap.trim() || "(empty)",
    "",
    "## DATA_MODELS.md",
    pkg.blueprint.dataModels.trim() || "(empty)",
    "",
    "## API_DESIGN.md",
    pkg.blueprint.apiDesign.trim() || "(empty)",
    "",
    "## AI_INSTRUCTIONS.md",
    pkg.blueprint.aiInstructions.trim() || "(empty)",
    "",
    "## CONTEXT.md",
    pkg.blueprint.context.trim() || "(empty)",
    "",
    "## FILE_STRUCTURE.md",
    pkg.blueprint.fileStructure.trim() || "(empty)",
  ];
  let body = sections.join("\n");
  if (body.length > MAX_CONTEXT_CHARS) {
    body =
      body.slice(0, MAX_CONTEXT_CHARS) +
      `\n\n… (truncated to ${MAX_CONTEXT_CHARS} chars for v1 prompt size; full docs remain in control-plane KV.)`;
  }
  return body;
}

/**
 * Load project and require {@link ProjectReadiness} `ready` for orchestration.
 * Logs: blueprint_load_start | blueprint_load_success | blueprint_load_failure
 */
export async function loadReadyControlPlaneProjectBlueprint(
  env: Env,
  projectId: string
): Promise<ProjectBlueprintContextPackage> {
  const id = projectId.trim();
  console.info("blueprint_load_start", JSON.stringify({ projectId: id }));

  if (!env.COORDINATOR_CONTROL_PLANE_KV) {
    const msg = "COORDINATOR_CONTROL_PLANE_KV is not bound — cannot load project blueprint.";
    console.info("blueprint_load_failure", JSON.stringify({ projectId: id, reason: "kv_missing" }));
    throw new OrchestrationBlueprintError(msg, 503);
  }

  const project = await getProject(env, id);
  if (!project) {
    console.info("blueprint_load_failure", JSON.stringify({ projectId: id, reason: "not_found" }));
    throw new OrchestrationBlueprintError(`Control-plane project not found: ${id}`, 404);
  }

  if (project.readiness !== "ready") {
    const hint = project.validationErrors?.length
      ? ` Validation: ${project.validationErrors.join("; ")}`
      : "";
    console.info(
      "blueprint_load_failure",
      JSON.stringify({ projectId: id, reason: "not_ready", readiness: project.readiness })
    );
    throw new OrchestrationBlueprintError(
      `Project is not ready for orchestration (readiness=${project.readiness}).${hint}`,
      400
    );
  }

  const pkg = buildContextPackageFromProject(project);
  console.info(
    "blueprint_load_success",
    JSON.stringify({ projectId: id, readiness: pkg.readiness, sharedProjectId: pkg.sharedProjectId })
  );
  return pkg;
}
