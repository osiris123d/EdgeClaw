import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleBlueprintContextForCodingTask,
  extractTaskKeywords,
} from "../assembleBlueprintContextForCodingTask";
import type { ProjectBlueprintContextPackage } from "../projectBlueprintOrchestrationContext";

function basePkg(blueprint: ProjectBlueprintContextPackage["blueprint"]): ProjectBlueprintContextPackage {
  return {
    projectId: "cp-1",
    projectName: "Test",
    projectSlug: "test",
    sharedProjectId: "ws-1",
    readiness: "ready",
    blueprint,
  };
}

test("extractTaskKeywords keeps backtick ids", () => {
  const k = extractTaskKeywords("Use `debug-orch-success` and shared_workspace patch flow");
  assert(k.includes("debug-orch-success"));
});

test("assemble: task_scoped when blueprint matches task terms", () => {
  const spec =
    "The checkout service talks to Stripe webhooks.\n\nUnrelated inventory SKUs live elsewhere.\n\n".repeat(120);
  const r = assembleBlueprintContextForCodingTask(
    basePkg({
      projectSpec: spec,
      roadmap: "",
      dataModels: "",
      apiDesign: "POST /checkout\n\n",
      aiInstructions: "",
      context: "",
      fileStructure: "",
    }),
    "[DEBUG] implement `checkout` with Stripe webhooks"
  );
  assert.equal(r.mode, "task_scoped");
  assert.match(r.markdown, /checkout/i);
});

test("assemble: full_fallback when huge blueprint has no query overlap", () => {
  const noise = "block alpha metrics pipeline\n\n".repeat(400);
  const r = assembleBlueprintContextForCodingTask(
    basePkg({
      projectSpec: noise,
      roadmap: noise,
      dataModels: noise,
      apiDesign: "",
      aiInstructions: "",
      context: "",
      fileStructure: "",
    }),
    "Implement the `zzz-unique-token-78432` module only"
  );
  assert.equal(r.mode, "full_fallback");
});

test("assemble: includes FILE_STRUCTURE excerpt when doc present", () => {
  const fsDoc =
    "## Staging\nUse staging/api/foo.ts.\n\n## Mapping\nstaging/api → src/api.\n\n".repeat(5);
  const r = assembleBlueprintContextForCodingTask(
    basePkg({
      projectSpec: "spec",
      roadmap: "- [ ] task",
      dataModels: "model",
      apiDesign: "",
      aiInstructions: "ai",
      context: "ctx",
      fileStructure: fsDoc,
    }),
    "Add a backend route for tasks"
  );
  assert.match(r.markdown, /FILE_STRUCTURE/i);
  assert.match(r.markdown, /staging\/api/i);
});
