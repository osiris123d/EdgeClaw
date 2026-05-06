import assert from "node:assert/strict";
import test from "node:test";
import { createPatch, parsePatch } from "diff";
import {
  applyPathMappings,
  materializeFromAppliedPatches,
  normalizePatchBodyForParse,
  normalizePatchFilePath,
  repairUnifiedDiffHunkHeaders,
  TEAM_TASK_TRACKER_PATH_MAPPINGS,
} from "../materializeProject";
import { resolveMaterializeMappingFromRequest } from "../materializePathMappings";
import { buildStoredZip } from "../materializeZip";

test("normalizePatchFilePath strips a/b prefixes and rejects traversal", () => {
  assert.equal(normalizePatchFilePath("b/src/foo.ts"), "src/foo.ts");
  assert.equal(normalizePatchFilePath("/dev/null"), null);
  assert.equal(normalizePatchFilePath("b/foo/../../../etc/passwd"), null);
});

test("applyPathMappings: simple staging/ prefix", () => {
  assert.equal(
    applyPathMappings("staging/schema.sql", [{ fromPrefix: "staging/", toPrefix: "db/" }]),
    "db/schema.sql"
  );
});

test("applyPathMappings: longest prefix wins among prefix rules", () => {
  assert.equal(
    applyPathMappings("staging/api/routes.ts", [
      { fromPrefix: "staging/", toPrefix: "db/" },
      { fromPrefix: "staging/api/", toPrefix: "src/api/" },
    ]),
    "src/api/routes.ts"
  );
});

test("applyPathMappings: Team Task Tracker explicit files and prefixes", () => {
  assert.equal(
    applyPathMappings("staging/schema.sql", TEAM_TASK_TRACKER_PATH_MAPPINGS),
    "db/schema.sql"
  );
  assert.equal(
    applyPathMappings("staging/types.ts", TEAM_TASK_TRACKER_PATH_MAPPINGS),
    "src/shared/types.ts"
  );
  assert.equal(
    applyPathMappings("staging/routes.ts", TEAM_TASK_TRACKER_PATH_MAPPINGS),
    "src/api/routes.ts"
  );
  assert.equal(
    applyPathMappings("staging/api/handlers.ts", TEAM_TASK_TRACKER_PATH_MAPPINGS),
    "src/api/handlers.ts"
  );
  assert.equal(
    applyPathMappings("staging/components/Button.tsx", TEAM_TASK_TRACKER_PATH_MAPPINGS),
    "frontend/src/components/Button.tsx"
  );
  assert.equal(
    applyPathMappings("staging/pages/Home.tsx", TEAM_TASK_TRACKER_PATH_MAPPINGS),
    "frontend/src/pages/Home.tsx"
  );
});

test("resolveMaterializeMappingFromRequest presets", () => {
  const tt = resolveMaterializeMappingFromRequest({ mappingPreset: "team_task_tracker" });
  assert.ok(!("error" in tt));
  assert.equal(tt.preset, "team_task_tracker");
  assert.ok(tt.rules.length >= 6);

  const ss = resolveMaterializeMappingFromRequest({ mappingPreset: "simple_staging" });
  assert.ok(!("error" in ss));
  assert.equal(ss.preset, "simple_staging");
  assert.equal(ss.rules.length, 1);

  const none = resolveMaterializeMappingFromRequest({ mappingPreset: "none" });
  assert.ok(!("error" in none));
  assert.equal(none.rules.length, 0);

  const legacy = resolveMaterializeMappingFromRequest({
    mappingPreset: "none",
    pathMappings: [{ fromPrefix: "x/", toPrefix: "y/" }],
  });
  assert.ok(!("error" in legacy));
  assert.equal(legacy.preset, "custom");
});

test("normalizePatchBodyForParse strips markdown fence", () => {
  assert.equal(normalizePatchBodyForParse("```diff\nfoo\n```"), "foo");
  assert.equal(normalizePatchBodyForParse("```\nbar\n```"), "bar");
});

test("materialize: strips markdown fences before parsePatch", () => {
  const inner = createPatch("staging/types.ts", "", "export type X = 1;\n");
  const fenced = "```diff\n" + inner + "\n```\n";
  const { files, skipped } = materializeFromAppliedPatches(
    [{ patchId: "f", updatedAt: "2026-01-01T00:00:00.000Z", body: fenced }],
    TEAM_TASK_TRACKER_PATH_MAPPINGS
  );
  assert.equal(skipped.length, 0);
  assert.equal(files.get("src/shared/types.ts"), "export type X = 1;\n");
});

test("repairUnifiedDiffHunkHeaders fixes under-counted new-file hunks", () => {
  const raw = `@@ -0,0 +1,2 @@
+a
+b
+c
`;
  const fixed = repairUnifiedDiffHunkHeaders(raw);
  assert.match(fixed, /\+1,3 @@/);
  assert.doesNotThrow(() => parsePatch(fixed));
});

test("materialize: repairs LLM-style @@ counts then applies Team Task Tracker mapping", () => {
  const body = `diff --git a/staging/schema.sql b/staging/schema.sql
--- /dev/null
+++ b/staging/schema.sql
@@ -0,0 +1,2 @@
+CREATE TABLE a (id TEXT);
+CREATE TABLE b (id TEXT);
+CREATE TABLE c (id TEXT);
`;
  const { files, skipped } = materializeFromAppliedPatches(
    [{ patchId: "schema", updatedAt: "2026-01-01T00:00:00.000Z", body }],
    TEAM_TASK_TRACKER_PATH_MAPPINGS
  );
  assert.equal(skipped.length, 0);
  const sql = files.get("db/schema.sql");
  assert.ok(sql?.includes("CREATE TABLE c"));
});

test("materialize: parsePatch_failed after repair surfaces error", () => {
  const bad = `--- a/x.ts
`;
  const { skipped, previewRows } = materializeFromAppliedPatches(
    [{ patchId: "bad", updatedAt: "2026-01-01T00:00:00.000Z", body: bad }],
    []
  );
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0]!.reason.startsWith("parsePatch_failed:"));
  assert.ok(/Missing|parsePatch_failed/i.test(previewRows[0]!.detail ?? ""));
});

test("materialize: sequential patches accumulate per path", () => {
  const p1 = createPatch("src/a.ts", "", "export const x = 1;\n");
  const p2 = createPatch("src/a.ts", "export const x = 1;\n", "export const x = 1;\nexport const y = 2;\n");

  const { files, conflicts, skipped, previewRows } = materializeFromAppliedPatches(
    [
      { patchId: "one", updatedAt: "2026-01-01T00:00:00.000Z", body: p1 },
      { patchId: "two", updatedAt: "2026-01-02T00:00:00.000Z", body: p2 },
    ],
    []
  );

  assert.equal(conflicts.length, 0);
  assert.equal(skipped.length, 0);
  assert.equal(files.get("src/a.ts"), "export const x = 1;\nexport const y = 2;\n");
  assert.equal(previewRows.filter((r) => r.status === "applied").length, 2);
});

test("materialize: conflict keeps prior buffer when later patch cannot apply", () => {
  const first = createPatch("src/a.ts", "", "export const x = 1;\n");
  const expectsDifferentBase = createPatch(
    "src/a.ts",
    "THIS LINE DOES NOT EXIST IN BUFFER\n",
    "replacement\n"
  );

  const { files, conflicts, previewRows } = materializeFromAppliedPatches(
    [
      { patchId: "ok", updatedAt: "2026-01-01T00:00:00.000Z", body: first },
      { patchId: "bad", updatedAt: "2026-01-02T00:00:00.000Z", body: expectsDifferentBase },
    ],
    []
  );

  assert.equal(files.get("src/a.ts"), "export const x = 1;\n");
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0]!.detail, /applyPatch_failed/i);
  assert.ok(previewRows.some((r) => r.patchId === "bad" && r.status === "conflict"));
});

test("materialize: pathMappings remap patch targets", () => {
  const body = createPatch("staging/schema.sql", "", "CREATE TABLE t (id int);\n");
  const { files } = materializeFromAppliedPatches(
    [{ patchId: "p", updatedAt: "2026-01-01T00:00:00.000Z", body }],
    [{ fromPrefix: "staging/", toPrefix: "db/" }]
  );
  assert.equal(files.has("staging/schema.sql"), false);
  assert.equal(files.get("db/schema.sql"), "CREATE TABLE t (id int);\n");
});

test("buildStoredZip emits PK header", () => {
  const z = buildStoredZip([{ path: "hello.txt", contentUtf8: "hi\n" }]);
  assert.equal(z[0], 0x50);
  assert.equal(z[1], 0x4b);
});
