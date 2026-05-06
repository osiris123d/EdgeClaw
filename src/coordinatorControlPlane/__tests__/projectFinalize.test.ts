import assert from "node:assert/strict";
import test from "node:test";
import {
  assessProjectFinalizeReadiness,
  buildFinalizeVerificationSummary,
  buildProjectFinalizeManifest,
  extractChangedPathsFromPatchBody,
} from "../projectFinalize";
import type { CoordinatorProject, CoordinatorTask } from "../types";

const baseProject = (): CoordinatorProject => ({
  projectId: "p1",
  projectName: "Test",
  projectSlug: "test",
  description: "",
  specPath: "",
  sharedProjectId: "shared-1",
  status: "active",
  blueprint: {
    schemaVersion: 1,
    docs: {
      "PROJECT_SPEC.md": "Implements src/api/routes.ts and models/User.ts",
    },
  },
  readiness: "ready",
  allowedScopeDirs: [],
  createdAt: "",
  updatedAt: "",
});

test("readiness: all done and clean passes", () => {
  const tasks: CoordinatorTask[] = [
    {
      taskId: "t1",
      projectId: "p1",
      title: "A",
      description: "",
      assignedRole: "coder",
      status: "done",
      acceptanceCriteria: "",
      createdAt: "",
      updatedAt: "",
    },
  ];
  const r = assessProjectFinalizeReadiness(tasks);
  assert.equal(r.ok, true);
  assert.equal(r.reasons.length, 0);
});

test("readiness: todo fails", () => {
  const tasks: CoordinatorTask[] = [
    {
      taskId: "t1",
      projectId: "p1",
      title: "A",
      description: "",
      assignedRole: "coder",
      status: "todo",
      acceptanceCriteria: "",
      createdAt: "",
      updatedAt: "",
    },
  ];
  const r = assessProjectFinalizeReadiness(tasks);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("not done")));
});

test("readiness: needs_revision fails", () => {
  const tasks: CoordinatorTask[] = [
    {
      taskId: "t1",
      projectId: "p1",
      title: "A",
      description: "",
      assignedRole: "coder",
      status: "done",
      acceptanceCriteria: "",
      reviewDecision: "needs_revision",
      createdAt: "",
      updatedAt: "",
    },
  ];
  const r = assessProjectFinalizeReadiness(tasks);
  assert.equal(r.ok, false);
});

test("extractChangedPathsFromPatchBody parses git diff", () => {
  const body = `diff --git a/foo/bar.ts b/foo/bar.ts
--- a/foo/bar.ts
+++ b/foo/bar.ts
`;
  const paths = extractChangedPathsFromPatchBody(body);
  assert.ok(paths.includes("foo/bar.ts"));
});

test("verification: manifest ties patches to blueprint mentions", () => {
  const project = baseProject();
  const applied = [
    {
      patchId: "patch-a",
      record: {
        status: "applied" as const,
        body: `diff --git a/src/api/routes.ts b/src/api/routes.ts
--- a/src/api/routes.ts
+++ b/src/api/routes.ts
`,
        updatedAt: "",
      },
    },
  ];
  const manifest = buildProjectFinalizeManifest({
    project,
    tasks: [],
    appliedTaskPatches: applied,
    allPatchesListed: [{ patchId: "patch-a", status: "applied" }],
    readiness: { ok: true, reasons: [] },
    operatorAcknowledgesHumanReviewRequired: true,
  });
  assert.ok(manifest.filesChanged.some((f) => f.includes("routes.ts")));
  assert.ok(manifest.verification.uniquePathsTouched.some((p) => p.includes("routes")));
  assert.ok(manifest.verification.blueprintDocsChecked.includes("FILE_STRUCTURE.md"));
});

test("verification: non-applied non-debug patches block releaseReadyCandidate", () => {
  const project = baseProject();
  const summary = buildFinalizeVerificationSummary({
    project,
    appliedPatches: [],
    allPatchesListed: [{ patchId: "z", status: "pending" }],
    readinessOk: true,
  });
  assert.equal(summary.releaseReadyCandidate, false);
});
