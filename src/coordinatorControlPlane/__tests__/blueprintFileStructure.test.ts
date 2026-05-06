import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedTemplateBlueprint, generateFileStructureMd } from "../blueprintTemplateGenerators";
import { blueprintEffectiveSchema, validateProjectBlueprint } from "../blueprintValidation";
import { buildContextPackageFromProject } from "../projectBlueprintOrchestrationContext";
import { BLUEPRINT_FILE_KEYS } from "../types";
import type { CoordinatorProject, ProjectBlueprint } from "../types";

test("BLUEPRINT_FILE_KEYS includes FILE_STRUCTURE.md", () => {
  assert.ok(BLUEPRINT_FILE_KEYS.includes("FILE_STRUCTURE.md"));
});

test("validateProjectBlueprint: schema v1 does not require FILE_STRUCTURE.md", () => {
  const bp: ProjectBlueprint = {
    schemaVersion: 1,
    docs: {
      "PROJECT_SPEC.md": "x".repeat(15),
      "ROADMAP.md": "- [ ] task\n",
      "AI_INSTRUCTIONS.md": "y".repeat(25),
      "CONTEXT.md": "z".repeat(25),
      "DATA_MODELS.md": "d".repeat(25),
    },
  };
  assert.equal(blueprintEffectiveSchema(bp), 1);
  const r = validateProjectBlueprint(bp);
  assert.equal(r.readiness, "ready");
  assert.equal(r.errors.length, 0);
});

test("validateProjectBlueprint: schema v2 requires FILE_STRUCTURE.md", () => {
  const bp: ProjectBlueprint = {
    schemaVersion: 2,
    docs: {
      "PROJECT_SPEC.md": "x".repeat(15),
      "ROADMAP.md": "- [ ] task\n",
      "AI_INSTRUCTIONS.md": "y".repeat(25),
      "CONTEXT.md": "z".repeat(25),
      "DATA_MODELS.md": "d".repeat(25),
    },
  };
  const r = validateProjectBlueprint(bp);
  assert.equal(r.readiness, "incomplete");
  assert.ok(r.errors.some((e) => e.includes("FILE_STRUCTURE")));
});

test("validateProjectBlueprint: schema v2 ready with FILE_STRUCTURE.md", () => {
  const bp: ProjectBlueprint = {
    schemaVersion: 2,
    docs: {
      "PROJECT_SPEC.md": "x".repeat(15),
      "ROADMAP.md": "- [ ] task\n",
      "AI_INSTRUCTIONS.md": "y".repeat(25),
      "CONTEXT.md": "z".repeat(25),
      "DATA_MODELS.md": "d".repeat(25),
      "FILE_STRUCTURE.md": generateFileStructureMd({
        projectName: "P",
        projectSlug: "p",
        entityName: "E",
        tableName: "e",
        method: "GET",
        apiPath: "/api",
      }),
    },
  };
  const r = validateProjectBlueprint(bp);
  assert.equal(r.readiness, "ready");
});

test("buildGeneratedTemplateBlueprint ships FILE_STRUCTURE and schemaVersion 2", () => {
  const bp = buildGeneratedTemplateBlueprint("Team Task Tracker", "team-task-tracker");
  assert.equal(bp.schemaVersion, 2);
  assert.ok(typeof bp.docs["FILE_STRUCTURE.md"] === "string");
  assert.ok(bp.docs["FILE_STRUCTURE.md"]!.includes("Team Task Tracker"));
  assert.ok(bp.docs["FILE_STRUCTURE.md"]!.includes("staging/"));
});

test("buildContextPackageFromProject tolerates missing FILE_STRUCTURE.md", () => {
  const project: CoordinatorProject = {
    projectId: "p",
    projectName: "N",
    projectSlug: "n",
    description: "",
    specPath: "",
    sharedProjectId: "w",
    status: "active",
    blueprint: {
      schemaVersion: 1,
      docs: { "PROJECT_SPEC.md": "spec" },
    },
    readiness: "draft",
    allowedScopeDirs: [],
    createdAt: "",
    updatedAt: "",
  };
  const pkg = buildContextPackageFromProject(project);
  assert.equal(typeof pkg.blueprint.fileStructure, "string");
  assert.equal(pkg.blueprint.fileStructure, "");
});
