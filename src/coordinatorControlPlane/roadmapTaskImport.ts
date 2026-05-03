/**
 * Parse ROADMAP.md (blueprint doc body) into control-plane task specs and merge into existing tasks.
 *
 * v1: conservative, idempotent import — see module doc on `COORDINATOR_CONTROL_PLANE` README / user docs.
 */

import type { CoordinatorTask, CoordinatorTaskRole, CoordinatorTaskStatus } from "./types";

export interface ParsedRoadmapTask {
  /** Stable control-plane task id (e.g. `roadmap-TASK-001` or fingerprint-based). */
  proposedTaskId: string;
  /** Dedupe key across imports (normalized anchor + title). */
  sourceFingerprint: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  assignedRole: CoordinatorTaskRole;
  status: CoordinatorTaskStatus;
  /** Control-plane ids (`roadmap-TASK-*` or fingerprint ids). */
  dependsOnTaskIds: string[];
}

export interface RoadmapImportResult {
  created: number;
  updated: number;
  skipped: number;
  warnings: string[];
  /** Task ids touched (create or update). */
  touchedTaskIds: string[];
}

const TASK_HEADING = /^#{3,}\s*TASK-([A-Za-z0-9_-]+)\s*(.*)$/;
const KV_LINE = /^-\s*([^:]+):\s*(.*)$/;
const CHECKLIST = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(?!\[[ xX]\])(.+)$/;

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Deterministic short hash (sync, no subtle.crypto). */
export function roadmapFingerprint(parts: string[]): string {
  const s = parts.join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(33, h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + h.toString(16).padStart(8, "0");
}

function roadmapTaskIdForBlock(taskToken: string): string {
  const t = taskToken.trim();
  return `roadmap-${t}`;
}

function parseDependsLine(value: string): string[] {
  const v = value.trim();
  if (!v || /^none$/i.test(v)) return [];
  const out: string[] = [];
  for (const part of v.split(/[,;]+/)) {
    const m = part.trim().match(/^TASK-([A-Za-z0-9_-]+)$/i);
    if (m) out.push(roadmapTaskIdForBlock(`TASK-${m[1]}`));
  }
  return out;
}

function normalizeRole(raw: string): CoordinatorTaskRole {
  const r = raw.trim().toLowerCase();
  if (r === "coder" || r === "tester" || r === "coordinator") return r;
  return "coordinator";
}

function normalizeStatus(raw: string): CoordinatorTaskStatus | null {
  const r = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (r === "todo" || r === "in_progress" || r === "blocked" || r === "review" || r === "done") return r;
  return null;
}

/**
 * Extract tasks from ROADMAP.md body.
 *
 * Supported syntax (v1):
 * - `### TASK-XYZ` … blocks with bullet lines `- Title:`, `- Status:`, `- Owner:`, `- Depends on:`, `- Acceptance Criteria:` (and optional `- Files/Scope:` folded into description).
 * - Markdown checklist lines `- [ ] item` / `- [x] item` under any heading; checkbox state maps to todo/done.
 * - Plain bullets `- item` (non-checkbox) under `##` / `###` sections as low-priority tasks (short titles only).
 */
export function parseRoadmapMarkdown(markdown: string, projectId: string): ParsedRoadmapTask[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: ParsedRoadmapTask[] = [];
  let sectionHeading = "";

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const head = line.match(TASK_HEADING);
    if (head) {
      const taskToken = `TASK-${head[1]}`;
      const proposedTaskId = roadmapTaskIdForBlock(taskToken);
      let title = (head[2] ?? "").trim();
      let description = "";
      let acceptanceCriteria = "";
      let assignedRole: CoordinatorTaskRole = "coordinator";
      let status: CoordinatorTaskStatus = "todo";
      let dependsRaw = "none";
      i += 1;
      while (i < lines.length) {
        const L = lines[i]!;
        if (/^#{1,6}\s/.test(L)) break;
        const kv = L.match(KV_LINE);
        if (kv) {
          const key = kv[1]!.trim().toLowerCase();
          const val = kv[2]!.trim();
          if (key === "title") title = val || title;
          else if (key === "status") {
            const st = normalizeStatus(val);
            if (st) status = st;
          } else if (key === "owner") assignedRole = normalizeRole(val);
          else if (key === "depends on") dependsRaw = val;
          else if (key === "acceptance criteria") acceptanceCriteria = val;
          else if (key === "files/scope" || key === "scope") {
            description = description ? `${description}\n${L.trim()}` : L.trim();
          }
        } else if (L.trim() === "") {
          i += 1;
          break;
        }
        i += 1;
      }
      const fp = roadmapFingerprint([projectId, "taskblock", proposedTaskId, norm(title)]);
      out.push({
        proposedTaskId,
        sourceFingerprint: fp,
        title: title || taskToken,
        description,
        acceptanceCriteria,
        assignedRole,
        status,
        dependsOnTaskIds: parseDependsLine(dependsRaw),
      });
      continue;
    }

    const hm = line.match(/^#{2,6}\s+(.+)$/);
    if (hm) {
      sectionHeading = hm[1]!.trim();
      i += 1;
      continue;
    }

    const cm = line.match(CHECKLIST);
    if (cm) {
      const checked = cm[2]!.toLowerCase() === "x";
      const tit = cm[3]!.trim();
      if (tit.length > 0) {
        const fp = roadmapFingerprint([projectId, "checklist", sectionHeading, norm(tit)]);
        const proposedTaskId = `roadmap-fp-${fp.slice(0, 20)}`;
        out.push({
          proposedTaskId,
          sourceFingerprint: fp,
          title: tit.slice(0, 500),
          description: sectionHeading ? `From section: ${sectionHeading}` : "",
          acceptanceCriteria: "",
          assignedRole: "coordinator",
          status: checked ? "done" : "todo",
          dependsOnTaskIds: [],
        });
      }
      i += 1;
      continue;
    }

    const bm = line.match(BULLET);
    if (bm && sectionHeading && !/^status legend/i.test(sectionHeading)) {
      const tit = bm[2]!.trim();
      if (tit.length > 3 && tit.length < 400 && !tit.startsWith("`todo`")) {
        const nt = norm(tit);
        if (nt === "none yet" || nt === "n/a" || nt === "tbd" || nt === "none") {
          i += 1;
          continue;
        }
        const fp = roadmapFingerprint([projectId, "bullet", sectionHeading, norm(tit)]);
        const proposedTaskId = `roadmap-fp-${fp.slice(0, 20)}`;
        out.push({
          proposedTaskId,
          sourceFingerprint: fp,
          title: tit,
          description: `From section: ${sectionHeading}`,
          acceptanceCriteria: "",
          assignedRole: "coordinator",
          status: "todo",
          dependsOnTaskIds: [],
        });
      }
    }

    i += 1;
  }

  dedupeParsed(out);
  return out;
}

function dedupeParsed(items: ParsedRoadmapTask[]): void {
  const seen = new Set<string>();
  for (let j = items.length - 1; j >= 0; j--) {
    const fp = items[j]!.sourceFingerprint;
    if (seen.has(fp)) items.splice(j, 1);
    else seen.add(fp);
  }
}

function hasExecutionMetadata(t: CoordinatorTask): boolean {
  return Boolean(
    t.lastRunId ||
      t.lastRunStatus ||
      t.lastRunSummary ||
      t.lastRunFinishedAt ||
      t.lastRunErrorNote ||
      (t.status !== "todo" && t.status !== "done")
  );
}

/**
 * Merge parsed roadmap items into `tasks` for one project. Single-writer style: returns next task array for the project slice + other tasks unchanged.
 */
export function mergeRoadmapImportIntoTasks(
  allTasks: CoordinatorTask[],
  projectId: string,
  parsed: ParsedRoadmapTask[],
  nowIso: string
): { tasks: CoordinatorTask[]; result: RoadmapImportResult } {
  const warnings: string[] = [];
  const touched: string[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const byId = new Map(allTasks.map((t) => [t.taskId, t]));
  const projectTasks = allTasks.filter((t) => t.projectId === projectId);

  const findMatch = (p: ParsedRoadmapTask): CoordinatorTask | undefined => {
    const byFp = projectTasks.find((t) => t.taskSource === "roadmap" && t.sourceFingerprint === p.sourceFingerprint);
    if (byFp) return byFp;
    return byId.get(p.proposedTaskId);
  };

  const next = [...allTasks];

  for (const p of parsed) {
    const existing = findMatch(p);
    if (!existing) {
      const row: CoordinatorTask = {
        taskId: p.proposedTaskId,
        projectId,
        title: p.title,
        description: p.description,
        assignedRole: p.assignedRole,
        status: p.status,
        acceptanceCriteria: p.acceptanceCriteria,
        taskSource: "roadmap",
        importedFromRoadmap: true,
        sourceFingerprint: p.sourceFingerprint,
        dependsOnTaskIds: p.dependsOnTaskIds.length ? [...p.dependsOnTaskIds] : undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      next.push(row);
      byId.set(row.taskId, row);
      touched.push(row.taskId);
      created += 1;
      continue;
    }

    if (existing.projectId !== projectId) {
      warnings.push(`skip ${p.proposedTaskId}: taskId exists on another project`);
      skipped += 1;
      continue;
    }

    if (existing.taskSource && existing.taskSource !== "roadmap") {
      warnings.push(`skip ${existing.taskId}: not a roadmap task (source=${existing.taskSource})`);
      skipped += 1;
      continue;
    }

    const exec = hasExecutionMetadata(existing);
    if (exec) {
      const patch: Partial<CoordinatorTask> = {
        dependsOnTaskIds: p.dependsOnTaskIds.length ? [...p.dependsOnTaskIds] : existing.dependsOnTaskIds,
        updatedAt: nowIso,
      };
      if (!existing.description?.trim() && p.description.trim()) {
        patch.description = p.description;
      }
      if (!existing.acceptanceCriteria?.trim() && p.acceptanceCriteria.trim()) {
        patch.acceptanceCriteria = p.acceptanceCriteria;
      }
      const idx = next.findIndex((t) => t.taskId === existing.taskId);
      if (idx >= 0) {
        next[idx] = { ...next[idx]!, ...patch, taskId: existing.taskId, createdAt: next[idx]!.createdAt };
        touched.push(existing.taskId);
        updated += 1;
      }
      continue;
    }

    const idx = next.findIndex((t) => t.taskId === existing.taskId);
    if (idx < 0) continue;
    next[idx] = {
      ...existing,
      title: p.title,
      description: p.description,
      acceptanceCriteria: p.acceptanceCriteria,
      assignedRole: p.assignedRole,
      status: p.status,
      dependsOnTaskIds: p.dependsOnTaskIds.length ? [...p.dependsOnTaskIds] : undefined,
      taskSource: "roadmap",
      importedFromRoadmap: true,
      sourceFingerprint: p.sourceFingerprint,
      updatedAt: nowIso,
    };
    touched.push(existing.taskId);
    updated += 1;
  }

  for (const t of next.filter((x) => x.projectId === projectId)) {
    for (const depId of t.dependsOnTaskIds ?? []) {
      const id = depId.trim();
      if (!id) continue;
      if (!next.some((x) => x.taskId === id)) {
        warnings.push(`Task ${t.taskId} references missing dependency "${id}"`);
      }
    }
  }

  return {
    tasks: next,
    result: {
      created,
      updated,
      skipped,
      warnings,
      touchedTaskIds: touched,
    },
  };
}
