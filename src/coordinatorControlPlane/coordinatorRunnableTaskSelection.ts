/**
 * Selects the next task for bounded project autonomy (conservative v1).
 * Roadmap-first ordering; skips autopilot blocker follow-ups; lightweight dependency checks.
 *
 * Pick pool: {@link CoordinatorTask.status} `todo` or `in_progress` (re-runs / rework), preferring `todo`
 * when ordering. Dependencies still require upstream `done` or `review`.
 */

import type { Env } from "../lib/env";
import { getProject, listTasksForProject } from "./coordinatorControlPlaneStore";
import type { CoordinatorTask } from "./types";

export type PickRunnableTaskFailureReason =
  | "project_not_found"
  | "project_archived"
  | "project_not_ready"
  | "no_todo_tasks"
  | "no_runnable_tasks"
  | "dependency_blocked"
  /** Debug `/debug/project-autonomy?taskId=` — id not in project task list. */
  | "forced_task_not_found"
  /** Forced task belongs to another project (data inconsistency). */
  | "forced_task_wrong_project"
  /** Forced task exists but is not `todo` / `in_progress`. */
  | "forced_task_not_pickable";

/** Optional overrides for task selection (project autonomy). */
export interface PickRunnableTaskOptions {
  /** When set, select this task id directly (`todo` / `in_progress` / `review`-eligible paths only). */
  forceTaskId?: string;
}

export interface PickRunnableTaskAuditEntry {
  taskId: string;
  reason: "selected" | "skipped_generation_policy" | "skipped_unmet_dependencies";
  unmetDependencies?: string[];
}

export type PickRunnableTaskResult =
  | {
      ok: true;
      task: CoordinatorTask;
      selectionReason: string;
      audit: PickRunnableTaskAuditEntry[];
    }
  | {
      ok: false;
      reason: PickRunnableTaskFailureReason;
      audit?: PickRunnableTaskAuditEntry[];
      /** When reason is dependency_blocked: pickable tasks that had at least one unsatisfied dependency. */
      skippedDueToDependencies?: { taskId: string; unmet: string[] }[];
    };

/** v1: dependency satisfied when upstream is done or in review (awaiting approval still unblocks planning). */
export function isDependencySatisfiedForAutonomy(dep: CoordinatorTask | undefined): boolean {
  if (!dep) return false;
  return dep.status === "done" || dep.status === "review";
}

function taskTier(t: CoordinatorTask): number {
  if (t.taskSource === "roadmap") return 0;
  if (t.taskSource === "manual" || t.taskSource === undefined) return 1;
  if (t.taskSource === "coordinator_generated") return 2;
  if (t.taskSource === "tester_generated" || t.taskSource === "mainagent_generated") return 3;
  return 2;
}

function unmetDependencyIds(task: CoordinatorTask, byId: Map<string, CoordinatorTask>): string[] {
  const ids = task.dependsOnTaskIds ?? [];
  const unmet: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    const dep = byId.get(id);
    if (!isDependencySatisfiedForAutonomy(dep)) unmet.push(id);
  }
  return unmet;
}

/** Prefer fresh queue work (`todo`) before re-invoking `in_progress` tasks at the same tier. */
function autonomyStatusSortKey(t: CoordinatorTask): number {
  if (t.status === "todo") return 0;
  if (t.status === "in_progress") return 1;
  return 2;
}

function isAutonomyPickableStatus(t: CoordinatorTask): boolean {
  return t.status === "todo" || t.status === "in_progress";
}

/**
 * Picks the next **todo** or **in_progress** task for autonomy. Excludes investigation / infra follow-ups from autopilot.
 * Skips tasks whose {@link CoordinatorTask.dependsOnTaskIds} are not all satisfied (done or review), unless
 * {@link PickRunnableTaskOptions.forceTaskId} is set (direct task run).
 */
export async function pickNextRunnableTaskForProject(
  env: Env,
  projectId: string,
  pickOptions?: PickRunnableTaskOptions
): Promise<PickRunnableTaskResult> {
  const id = projectId.trim();
  const project = await getProject(env, id);
  if (!project) return { ok: false, reason: "project_not_found" };
  if (project.status === "archived") return { ok: false, reason: "project_archived" };
  if (project.readiness !== "ready") return { ok: false, reason: "project_not_ready" };

  const tasks = await listTasksForProject(env, id);
  const byId = new Map(tasks.map((t) => [t.taskId, t]));

  const forceId = pickOptions?.forceTaskId?.trim();
  const skipDependencyChecks = forceId != null && forceId !== "";

  if (forceId) {
    const t = byId.get(forceId);
    const audit: PickRunnableTaskAuditEntry[] = [];
    if (!t) {
      console.info(
        "project_autonomy_forced_task_missing",
        JSON.stringify({ projectId: id, taskId: forceId })
      );
      return { ok: false, reason: "forced_task_not_found" };
    }
    if (t.projectId.trim() !== id) {
      console.info(
        "project_autonomy_forced_task_wrong_project",
        JSON.stringify({
          projectId: id,
          taskId: forceId,
          taskProjectId: t.projectId,
        })
      );
      return { ok: false, reason: "forced_task_wrong_project" };
    }
    if (!isAutonomyPickableStatus(t)) {
      console.info(
        "project_autonomy_forced_task_bad_status",
        JSON.stringify({ projectId: id, taskId: forceId, status: t.status })
      );
      return { ok: false, reason: "forced_task_not_pickable" };
    }
    audit.push({ taskId: t.taskId, reason: "selected" });
    console.info(
      "project_autonomy_task_selected",
      JSON.stringify({
        projectId: id,
        taskId: t.taskId,
        selectionReason: "debug_forced_task_id",
        forced: true,
        dependencyChecksSkipped: skipDependencyChecks,
      })
    );
    return {
      ok: true,
      task: t,
      selectionReason: "debug_forced_task_id",
      audit,
    };
  }

  const pickable = tasks.filter((t) => isAutonomyPickableStatus(t));
  if (pickable.length === 0) {
    return { ok: false, reason: "no_todo_tasks" };
  }

  const eligible = pickable.filter(
    (t) => t.generationReason !== "blocker_investigation" && t.generationReason !== "missing_dependency"
  );

  const audit: PickRunnableTaskAuditEntry[] = [];
  const skippedDueToDependencies: { taskId: string; unmet: string[] }[] = [];

  if (eligible.length === 0) {
    for (const t of pickable) {
      audit.push({ taskId: t.taskId, reason: "skipped_generation_policy" });
    }
    console.info(
      "project_autonomy_pick_scan",
      JSON.stringify({
        projectId,
        outcome: "no_runnable_tasks",
        note: "all_pickable_filtered_by_generation_policy",
      })
    );
    return { ok: false, reason: "no_runnable_tasks", audit };
  }

  eligible.sort((a, b) => {
    const sd = autonomyStatusSortKey(a) - autonomyStatusSortKey(b);
    if (sd !== 0) return sd;
    const d = taskTier(a) - taskTier(b);
    if (d !== 0) return d;
    return a.createdAt.localeCompare(b.createdAt);
  });

  for (const t of eligible) {
    const unmet = unmetDependencyIds(t, byId);
    if (unmet.length > 0) {
      audit.push({ taskId: t.taskId, reason: "skipped_unmet_dependencies", unmetDependencies: unmet });
      skippedDueToDependencies.push({ taskId: t.taskId, unmet });
      console.info(
        "project_autonomy_dependency_check",
        JSON.stringify({ projectId, taskId: t.taskId, satisfied: false, unmet })
      );
      continue;
    }
    audit.push({ taskId: t.taskId, reason: "selected" });
    const tier = taskTier(t);
    const selectionReason = `tier_${tier}_fifo_createdAt_deps_ok (roadmap→manual→generated)`;
    console.info(
      "project_autonomy_task_selected",
      JSON.stringify({
        projectId,
        taskId: t.taskId,
        selectionReason,
        tier,
      })
    );
    return { ok: true, task: t, selectionReason, audit };
  }

  console.info(
    "project_autonomy_pick_scan",
    JSON.stringify({
      projectId,
      outcome: "dependency_blocked",
      skippedCount: skippedDueToDependencies.length,
    })
  );

  return {
    ok: false,
    reason: "dependency_blocked",
    audit,
    skippedDueToDependencies,
  };
}

/** True if any task is in a status project autonomy may pick (`todo` or `in_progress`). */
export async function hasAnyTodoTask(env: Env, projectId: string): Promise<boolean> {
  const tasks = await listTasksForProject(env, projectId.trim());
  return tasks.some((t) => isAutonomyPickableStatus(t));
}
