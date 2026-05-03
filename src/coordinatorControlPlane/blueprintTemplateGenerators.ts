/**
 * Strong default blueprint bodies for Sub-Agents “Generate templates”.
 * Keep placeholders minimal: {{PROJECT_NAME}}, {{PROJECT_SLUG}}, plus API/data stubs.
 */

import { withComputedDocState } from "./blueprintDocMeta";
import { slugifyProjectName } from "./projectSlug";
import type { BlueprintFileKey, ProjectBlueprint } from "./types";
import { BLUEPRINT_FILE_KEYS } from "./types";

export interface BlueprintTemplateContext {
  projectName: string;
  projectSlug: string;
  entityName: string;
  tableName: string;
  method: string;
  apiPath: string;
}

function slugToPascal(slug: string): string {
  const parts = slug.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "Project";
  return parts.map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join("");
}

export function buildTemplateContext(projectName: string, projectSlug: string): BlueprintTemplateContext {
  const name = projectName.trim() || "Untitled project";
  const slug = projectSlug.trim() || slugifyProjectName(name) || "project";
  const pascal = slugToPascal(slug);
  const snake = slug.replace(/-/g, "_");
  return {
    projectName: name,
    projectSlug: slug,
    entityName: `${pascal}Record`,
    tableName: `${snake}_records`,
    method: "GET",
    apiPath: `/api/v1/${slug}`,
  };
}

function subst(tmpl: string, c: BlueprintTemplateContext): string {
  return tmpl
    .replaceAll("{{PROJECT_NAME}}", c.projectName)
    .replaceAll("{{PROJECT_SLUG}}", c.projectSlug)
    .replaceAll("{{ENTITY_NAME}}", c.entityName)
    .replaceAll("{{TABLE_NAME}}", c.tableName)
    .replaceAll("{{METHOD}}", c.method)
    .replaceAll("{{PATH}}", c.apiPath);
}

export function generateProjectSpecMd(c: BlueprintTemplateContext): string {
  return subst(
    [
      "# PROJECT_SPEC.md",
      "",
      "## Project Name",
      "{{PROJECT_NAME}}",
      "",
      "## Project Slug",
      "{{PROJECT_SLUG}}",
      "",
      "## Summary",
      "A short description of the project in 2 to 4 sentences.",
      "",
      "## Business Goal",
      "What business or user problem does this project solve?",
      "",
      "## Primary Users",
      "Who will use this system?",
      "- User type 1",
      "- User type 2",
      "",
      "## Success Criteria",
      "How will we know this project is successful?",
      "- [ ] Criterion 1",
      "- [ ] Criterion 2",
      "- [ ] Criterion 3",
      "",
      "## In Scope",
      "- Feature 1",
      "- Feature 2",
      "- Feature 3",
      "",
      "## Out of Scope",
      "- Exclusion 1",
      "- Exclusion 2",
      "",
      "## Tech Stack",
      "- Frontend:",
      "- Backend:",
      "- Database:",
      "- Hosting/Runtime:",
      "- Auth:",
      "- Storage:",
      "- Testing:",
      "",
      "## Architecture Summary",
      "- Main user-facing application",
      "- API/service layer",
      "- Database/storage layer",
      "- Background jobs/workflows",
      "- AI coordinator/sub-agent orchestration",
      "",
      "## Constraints",
      "- Must run on Cloudflare Workers",
      "- Must use D1",
      "- Must not use long-running background servers",
      "- Must support mobile browsers",
      "",
      "## Non-Functional Requirements",
      "- Performance:",
      "- Reliability:",
      "- Security:",
      "- Accessibility:",
      "- Observability:",
      "",
      "## Acceptance Criteria",
      "- [ ] Users can …",
      "- [ ] System stores …",
      "- [ ] Admin can …",
      "- [ ] Tests cover …",
      "",
      "## Open Questions",
      "- Question 1",
      "- Question 2",
    ].join("\n"),
    c
  );
}

export function generateRoadmapMd(c: BlueprintTemplateContext): string {
  return subst(
    [
      "# ROADMAP.md",
      "",
      "## Project",
      "{{PROJECT_NAME}}",
      "",
      "## Status Legend",
      "- `todo` · `in_progress` · `blocked` · `review` · `done`",
      "",
      "## Milestone 1: Foundation",
      "- [ ] Define project structure",
      "- [ ] Establish shared types",
      "- [ ] Set up core routes/endpoints",
      "- [ ] Set up data models",
      "- [ ] Add initial tests",
      "",
      "## Milestone 2: Core Features",
      "- [ ] Implement feature A",
      "- [ ] Implement feature B",
      "",
      "## Milestone 3: Integration",
      "- [ ] Connect frontend to backend",
      "- [ ] Add persistence",
      "- [ ] Add error handling",
      "",
      "## Milestone 4: Review and Hardening",
      "- [ ] Improve tests",
      "- [ ] Add observability/logging",
      "- [ ] Prepare deployment",
      "",
      "## Atomic Task Backlog",
      "",
      "### TASK-001",
      "- Title: Define shared domain types",
      "- Status: todo",
      "- Owner: coordinator",
      "- Depends on: none",
      "- Files/Scope: `/src/shared/types.ts`",
      "- Acceptance Criteria: Shared domain types are defined; no duplicate conflicting shapes.",
      "",
      "### TASK-002",
      "- Title: Implement initial data schema",
      "- Status: todo",
      "- Owner: coder",
      "- Depends on: TASK-001",
      "- Acceptance Criteria: Schema matches DATA_MODELS.md",
      "",
      "### TASK-003",
      "- Title: Verify schema and type alignment",
      "- Status: todo",
      "- Owner: tester",
      "- Depends on: TASK-002",
      "- Acceptance Criteria: Tester confirms schema/types alignment",
      "",
      "## Blockers",
      "- None yet",
      "",
      "## Notes",
      "Coordinator should prefer TASK-* sections for delegation.",
    ].join("\n"),
    c
  );
}

export function generateDataModelsMd(c: BlueprintTemplateContext): string {
  return subst(
    [
      "# DATA_MODELS.md",
      "",
      "## Overview",
      "Source-of-truth data structures for {{PROJECT_NAME}}.",
      "",
      "## Data Storage Strategy",
      "- Primary database:",
      "- Secondary storage:",
      "- Cache/session storage:",
      "- Files/artifacts storage:",
      "",
      "## Domain Entities",
      "- Entity A",
      "- Entity B",
      "",
      "---",
      "",
      "## Entity: {{ENTITY_NAME}}",
      "",
      "### Purpose",
      "What this entity represents.",
      "",
      "### Fields",
      "| Field | Type | Required | Description |",
      "|------|------|----------|-------------|",
      "| id | string | yes | Unique identifier |",
      "| createdAt | string | yes | ISO timestamp |",
      "| updatedAt | string | yes | ISO timestamp |",
      "",
      "### Relationships",
      "- Belongs to:",
      "- Has many:",
      "",
      "### Example JSON",
      "```json",
      "{",
      '  "id": "example-id",',
      '  "createdAt": "2026-01-01T00:00:00.000Z",',
      '  "updatedAt": "2026-01-01T00:00:00.000Z"',
      "}",
      "```",
      "",
      "## Database Tables (SQL/D1)",
      "",
      "### Table: {{TABLE_NAME}}",
      "| Column | Type | Nullable | Notes |",
      "|--------|------|----------|-------|",
      "| id | TEXT | no | Primary key |",
      "",
      "## Shared Types Contract",
      "- Project",
      "- Task",
      "- User",
      "- ApiResponse (generic success/error wrapper)",
      "",
      "## Invariants",
      "- A task must belong to a valid project",
      "- Status must be one of the allowed enum values",
      "",
      "## Open Questions",
      "- Question 1",
    ].join("\n"),
    c
  );
}

export function generateApiDesignMd(c: BlueprintTemplateContext): string {
  return subst(
    [
      "# API_DESIGN.md",
      "",
      "## Overview",
      "API contract for {{PROJECT_NAME}}.",
      "",
      "## API Style",
      "- REST / RPC / hybrid:",
      "- Base path:",
      "- Auth approach:",
      "- Response format:",
      "- Error format:",
      "",
      "## Conventions",
      "- Timestamps are ISO strings",
      "- IDs are strings",
      "- Structured JSON errors",
      "",
      "---",
      "",
      "## Endpoint: {{METHOD}} {{PATH}}",
      "",
      "### Purpose",
      "Example read operation.",
      "",
      "### Auth",
      "- Required / Optional / None",
      "",
      "### Request",
      "#### Path Params",
      "| Name | Type | Required | Description |",
      "|------|------|----------|-------------|",
      "",
      "#### Body",
      "```json",
      "{",
      '  "example": true',
      "}",
      "```",
      "",
      "### Response",
      "```json",
      "{",
      '  "ok": true,',
      '  "data": {}',
      "}",
      "```",
      "",
      "## Planned Endpoints",
      "- GET /...",
      "- POST /...",
      "",
      "## Contract Rules",
      "- Do not invent fields not listed here",
      "- Keep shared types aligned with DATA_MODELS.md",
      "",
      "## Open Questions",
      "- Question 1",
    ].join("\n"),
    c
  );
}

export function generateAiInstructionsMd(c: BlueprintTemplateContext): string {
  return subst(
    [
      "# AI_INSTRUCTIONS.md",
      "",
      "## Purpose",
      "Mandatory instructions for CoordinatorAgent, CoderAgent, and TesterAgent working on **{{PROJECT_NAME}}** (`{{PROJECT_SLUG}}`).",
      "",
      "## Global Rules",
      "- Follow PROJECT_SPEC.md, ROADMAP.md, DATA_MODELS.md, and API_DESIGN.md as source of truth.",
      "- Do not invent architecture not documented in blueprint files.",
      "- Do not modify unrelated files.",
      "- Scope changes to the assigned task.",
      "- Prefer small, reviewable diffs.",
      "- If blocked, document the blocker instead of risky assumptions.",
      "",
      "## CoordinatorAgent",
      "- Decompose roadmap into atomic tasks.",
      "- Build focused context packages per task.",
      "- Route implementation to CoderAgent and verification to TesterAgent.",
      "- Track task/run state; avoid broad edits unless required.",
      "",
      "## CoderAgent",
      "- Implement only the assigned task.",
      "- Obey DATA_MODELS.md and API_DESIGN.md.",
      "- Reuse existing types/components.",
      "- Do not invent schemas/endpoints without blueprint evidence.",
      "",
      "## TesterAgent",
      "- Verify against blueprint files with evidence.",
      "- No unauthorized writes.",
      "- Pass/fail with concrete reasons.",
      "",
      "## Forbidden Actions",
      "- Do not edit secrets/bindings casually.",
      "- Do not silently widen scope.",
      "",
      "## Definition of Done",
      "- Matches blueprint contracts",
      "- Validation passes",
      "- Status updated appropriately",
      "",
      "## Escalation",
      "- Blueprint conflicts, missing files, ambiguous scope, or risky migrations.",
    ].join("\n"),
    c
  );
}

export function generateContextMd(c: BlueprintTemplateContext): string {
  return subst(
    [
      "# CONTEXT.md",
      "",
      "## Current Project State",
      "Summarize what exists today for **{{PROJECT_NAME}}**.",
      "",
      "## What Has Already Been Built",
      "- Item 1",
      "- Item 2",
      "",
      "## Current Architecture Notes",
      "- Main runtime:",
      "- Storage:",
      "- Auth:",
      "- API structure:",
      "- Frontend structure:",
      "- Coordinator/sub-agent structure:",
      "",
      "## Current Environment",
      "- Environment name:",
      "- Key bindings/features:",
      "- Known disabled features:",
      "",
      "## Recent Changes",
      "- Change 1",
      "",
      "## Known Issues",
      "- Issue 1",
      "",
      "## Pending Decisions",
      "- Decision 1",
      "",
      "## Useful File Paths",
      "- `/src/...`",
      "- `/frontend/...`",
      "- `/db/...`",
      "- `/projects/{{PROJECT_SLUG}}/...`",
      "",
      "## Testing Notes",
      "- How to test locally:",
      "- Smoke tests:",
      "",
      "## Notes for Agents",
      "- Start with PROJECT_SPEC + ROADMAP before coding.",
      "- Reuse existing patterns; respect shared contracts.",
    ].join("\n"),
    c
  );
}

const GENERATORS: Record<BlueprintFileKey, (c: BlueprintTemplateContext) => string> = {
  "PROJECT_SPEC.md": generateProjectSpecMd,
  "ROADMAP.md": generateRoadmapMd,
  "DATA_MODELS.md": generateDataModelsMd,
  "API_DESIGN.md": generateApiDesignMd,
  "AI_INSTRUCTIONS.md": generateAiInstructionsMd,
  "CONTEXT.md": generateContextMd,
};

/** Returns a blueprint slice; use `only` to regenerate a single file for merge clients. */
export function buildGeneratedTemplateBlueprint(
  projectName: string,
  projectSlug: string,
  only?: BlueprintFileKey
): ProjectBlueprint {
  const ctx = buildTemplateContext(projectName, projectSlug);
  const keys: BlueprintFileKey[] = only ? [only] : [...BLUEPRINT_FILE_KEYS];
  const docs: ProjectBlueprint["docs"] = {};
  const templateFingerprints: ProjectBlueprint["templateFingerprints"] = {};
  for (const k of keys) {
    const body = GENERATORS[k](ctx);
    docs[k] = body;
    templateFingerprints[k] = body;
  }
  return withComputedDocState({ schemaVersion: 1, docs, templateFingerprints });
}
