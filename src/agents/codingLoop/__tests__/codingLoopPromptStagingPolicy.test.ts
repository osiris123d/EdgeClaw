import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOW_DIRECT_REPO_PATHS_MARKER,
  CODER_IMPLEMENTATION_PATH_POLICY_MARKDOWN,
  TESTER_IMPLEMENTATION_PATH_POLICY_MARKDOWN,
  collectNonStagingImplementationPaths,
  implementationPatchPathsPolicyBypass,
  taskAllowsDirectRepoImplementationPaths,
} from "../codingLoopImplementationPaths";

test("coder implementation policy stresses staging default and canonical-root prohibition", () => {
  assert.match(CODER_IMPLEMENTATION_PATH_POLICY_MARKDOWN, /staging\/<logical-path>/);
  assert.match(CODER_IMPLEMENTATION_PATH_POLICY_MARKDOWN, /\bsrc\//);
  assert.match(CODER_IMPLEMENTATION_PATH_POLICY_MARKDOWN, /\bfrontend\//);
  assert.match(CODER_IMPLEMENTATION_PATH_POLICY_MARKDOWN, /\bdb\//);
  assert.ok(CODER_IMPLEMENTATION_PATH_POLICY_MARKDOWN.includes(ALLOW_DIRECT_REPO_PATHS_MARKER));
});

test("tester implementation policy stresses mixed-path failure and exception marker", () => {
  assert.match(TESTER_IMPLEMENTATION_PATH_POLICY_MARKDOWN, /staging\//);
  assert.match(TESTER_IMPLEMENTATION_PATH_POLICY_MARKDOWN, /VERDICT:\s*FAIL/i);
  assert.match(TESTER_IMPLEMENTATION_PATH_POLICY_MARKDOWN, /mix/i);
  assert.ok(TESTER_IMPLEMENTATION_PATH_POLICY_MARKDOWN.includes(ALLOW_DIRECT_REPO_PATHS_MARKER));
});

test("collectNonStagingImplementationPaths flags canonical roots and accepts staging-only", () => {
  const patchSrcOnly = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
`;
  assert.deepEqual(collectNonStagingImplementationPaths([patchSrcOnly]), ["src/foo.ts"]);

  const patchStaging = `diff --git a/staging/handlers.ts b/staging/handlers.ts
--- a/staging/handlers.ts
+++ b/staging/handlers.ts
`;
  assert.deepEqual(collectNonStagingImplementationPaths([patchStaging]), []);

  const patchMixed = `${patchStaging}
diff --git a/frontend/x.tsx b/frontend/x.tsx
--- a/frontend/x.tsx
+++ b/frontend/x.tsx
`;
  const bad = collectNonStagingImplementationPaths([patchMixed]);
  assert.ok(bad.includes("frontend/x.tsx"));
  assert.ok(!bad.some((p) => p.startsWith("staging/")));
});

test("implementationPatchPathsPolicyBypass: flag or task marker", () => {
  assert.equal(
    implementationPatchPathsPolicyBypass({
      allowImplementationPatchesOutsideStaging: false,
      task: "Do thing",
    }),
    false
  );
  assert.equal(
    implementationPatchPathsPolicyBypass({
      allowImplementationPatchesOutsideStaging: true,
      task: "Do thing",
    }),
    true
  );
  assert.equal(
    implementationPatchPathsPolicyBypass({
      allowImplementationPatchesOutsideStaging: false,
      task: `Implement ${ALLOW_DIRECT_REPO_PATHS_MARKER}`,
    }),
    true
  );
  assert.ok(taskAllowsDirectRepoImplementationPaths(`[ ALLOW_DIRECT_REPO_PATHS ] in task`));
});
