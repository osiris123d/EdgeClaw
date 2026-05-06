import type { CoordinatorProject, CoordinatorTask } from "./types";
import { BLUEPRINT_FILE_KEYS, type BlueprintFileKey } from "./types";
import type { PatchProposalRecord } from "../workspace/sharedWorkspaceTypes";
import { isDebugSystemPatchId } from "./patchClassification";

export interface FinalizeReadinessResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Gate before emitting a finalize manifest: every registry task must be completed cleanly,
 * with no blocked review outcomes or unresolved follow-ups (non-done rows cover generated tasks too).
 */
export function assessProjectFinalizeReadiness(tasks: CoordinatorTask[]): FinalizeReadinessResult {
  const reasons: string[] = [];
  if (!tasks.length) {
    reasons.push("Project has no tasks in the registry — import a roadmap or add tasks first.");
    return { ok: false, reasons };
  }

  for (const t of tasks) {
    if (t.reviewDecision === "needs_revision") {
      reasons.push(`Task "${t.title}" (${t.taskId}) still has review decision "needs_revision".`);
    }
    if (t.reviewDecision === "blocked") {
      reasons.push(`Task "${t.title}" (${t.taskId}) still has review decision "blocked".`);
    }
    if (t.status !== "done") {
      reasons.push(`Task "${t.title}" (${t.taskId}) is not done — status is "${t.status}".`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** Extract candidate repo-relative paths from a unified diff / patch body. */
export function extractChangedPathsFromPatchBody(patchBody: string): string[] {
  const paths = new Set<string>();
  const lines = patchBody.split(/\r?\n/);
  for (const line of lines) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      const p = git[2]?.trim();
      if (p) paths.add(p);
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus?.[1]) {
      paths.add(plus[1].trim());
      continue;
    }
    const minus = /^--- a\/(.+)$/.exec(line);
    if (minus?.[1] && minus[1] !== "/dev/null") {
      paths.add(minus[1].trim());
    }
  }
  return [...paths].sort();
}

export interface BlueprintCoverageRow {
  path: string;
  mentionedInDocs: BlueprintFileKey[];
}

export interface FinalVerificationSummary {
  blueprintDocsChecked: BlueprintFileKey[];
  docLengths: Partial<Record<BlueprintFileKey, number>>;
  totalUnifiedPathsTouched: number;
  uniquePathsTouched: string[];
  /** Paths appearing in diffs that are not obviously referenced in blueprint markdown (heuristic). */
  pathsWeaklyCoveredByDocs: string[];
  blueprintCoverage: BlueprintCoverageRow[];
  narrativeBullets: string[];
  /** True only when readiness passed and there are no non-debug pending/approved patches left. */
  releaseReadyCandidate: boolean;
}

function normalizePathToken(p: string): string {
  return p.replace(/^\/+/, "").trim();
}

/** Cheap heuristic: path or its basename appears as substring in doc text. */
function pathMentionedInDoc(path: string, docText: string): boolean {
  const n = normalizePathToken(path);
  if (!n || !docText.includes(n)) {
    const base = n.split("/").pop();
    if (!base || base.length < 3) return false;
    return docText.includes(base);
  }
  return true;
}

export function buildFinalizeVerificationSummary(input: {
  project: CoordinatorProject;
  appliedPatches: Array<{ patchId: string; record: PatchProposalRecord }>;
  /** Full patch inventory for the shared workspace project (any status). */
  allPatchesListed: Array<{ patchId: string; status: string }>;
  readinessOk: boolean;
}): FinalVerificationSummary {
  const docs = input.project.blueprint?.docs ?? {};
  const blueprintDocsChecked = [...BLUEPRINT_FILE_KEYS];
  const docLengths: Partial<Record<BlueprintFileKey, number>> = {};
  for (const k of BLUEPRINT_FILE_KEYS) {
    const t = docs[k];
    docLengths[k] = typeof t === "string" ? t.length : 0;
  }

  const uniquePaths = new Set<string>();
  for (const { record } of input.appliedPatches) {
    for (const p of extractChangedPathsFromPatchBody(record.body)) {
      uniquePaths.add(normalizePathToken(p));
    }
  }
  const uniquePathsTouched = [...uniquePaths].filter(Boolean).sort();

  const blueprintCoverage: BlueprintCoverageRow[] = uniquePathsTouched.map((path) => {
    const mentionedInDocs: BlueprintFileKey[] = [];
    for (const k of BLUEPRINT_FILE_KEYS) {
      const text = docs[k];
      if (typeof text === "string" && text.length > 0 && pathMentionedInDoc(path, text)) {
        mentionedInDocs.push(k);
      }
    }
    return { path, mentionedInDocs };
  });

  const pathsWeaklyCoveredByDocs = blueprintCoverage.filter((r) => r.mentionedInDocs.length === 0).map((r) => r.path);

  const nonAppliedNonDebug = input.allPatchesListed.filter(
    (p) => p.status !== "applied" && !isDebugSystemPatchId(p.patchId)
  );

  const narrativeBullets: string[] = [];
  narrativeBullets.push(
    `Compared unified-diff paths from ${input.appliedPatches.length} applied patch(es) against blueprint markdown (${BLUEPRINT_FILE_KEYS.join(", ")}).`
  );
  if (pathsWeaklyCoveredByDocs.length) {
    narrativeBullets.push(
      `${pathsWeaklyCoveredByDocs.length} path(s) from patches are not obviously referenced in those docs — human review recommended before promoting to a real repo.`
    );
  } else if (uniquePathsTouched.length > 0) {
    narrativeBullets.push("Each touched path has at least a weak string match in one blueprint doc.");
  }
  if (nonAppliedNonDebug.length > 0) {
    narrativeBullets.push(
      `${nonAppliedNonDebug.length} non-applied (non-debug) patch(es) remain (${nonAppliedNonDebug.map((p) => `${p.patchId}:${p.status}`).join(", ")}) — resolve before treating the workspace as promotion-clean.`
    );
  }
  narrativeBullets.push(
    "This report is deterministic and advisory — it does not deploy code or call models. Approve promotion only after human review."
  );

  const releaseReadyCandidate =
    input.readinessOk && nonAppliedNonDebug.length === 0 && input.project.readiness === "ready";

  return {
    blueprintDocsChecked,
    docLengths,
    totalUnifiedPathsTouched: uniquePathsTouched.length,
    uniquePathsTouched,
    pathsWeaklyCoveredByDocs,
    blueprintCoverage,
    narrativeBullets,
    releaseReadyCandidate,
  };
}

export interface ProjectFinalizeManifest {
  schemaVersion: 1;
  generatedAt: string;
  controlPlaneProjectId: string;
  sharedProjectId: string;
  /** All tasks @ done when readiness.ok */
  taskIds: string[];
  /** Applied patches excluding debug/system ids */
  patchIds: string[];
  filesChanged: string[];
  readiness: FinalizeReadinessResult;
  verification: FinalVerificationSummary;
  /** Explicit operator acknowledgement — UI sets false until checkbox checked */
  operatorAcknowledgesHumanReviewRequired: boolean;
}

export function buildProjectFinalizeManifest(input: {
  project: CoordinatorProject;
  tasks: CoordinatorTask[];
  appliedTaskPatches: Array<{ patchId: string; record: PatchProposalRecord }>;
  allPatchesListed: Array<{ patchId: string; status: string }>;
  readiness: FinalizeReadinessResult;
  operatorAcknowledgesHumanReviewRequired: boolean;
}): ProjectFinalizeManifest {
  const verification = buildFinalizeVerificationSummary({
    project: input.project,
    appliedPatches: input.appliedTaskPatches,
    allPatchesListed: input.allPatchesListed,
    readinessOk: input.readiness.ok,
  });

  const filesChanged = new Set<string>();
  for (const { record } of input.appliedTaskPatches) {
    for (const p of extractChangedPathsFromPatchBody(record.body)) {
      filesChanged.add(normalizePathToken(p));
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    controlPlaneProjectId: input.project.projectId,
    sharedProjectId: input.project.sharedProjectId.trim(),
    taskIds: input.tasks.map((t) => t.taskId).sort(),
    patchIds: input.appliedTaskPatches.map((p) => p.patchId).sort(),
    filesChanged: [...filesChanged].filter(Boolean).sort(),
    readiness: input.readiness,
    verification,
    operatorAcknowledgesHumanReviewRequired: input.operatorAcknowledgesHumanReviewRequired,
  };
}
