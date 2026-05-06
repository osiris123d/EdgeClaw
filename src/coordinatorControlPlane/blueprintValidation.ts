import type { ProjectBlueprint, ProjectReadiness } from "./types";
import { BLUEPRINT_FILE_KEYS } from "./types";

export interface BlueprintValidationResult {
  readiness: ProjectReadiness;
  errors: string[];
}

/** Effective blueprint schema for validation (persisted v2, else legacy v1). */
export function blueprintEffectiveSchema(blueprint: ProjectBlueprint | undefined): 1 | 2 {
  return blueprint?.schemaVersion === 2 ? 2 : 1;
}

/** Detects checklist items, bullets, or numbered lines typical of roadmap tasks. */
export function roadmapHasTaskOrChecklistItem(markdown: string): boolean {
  const lines = markdown.split(/\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^[-*]\s+\[[ xX]\]/.test(t)) return true;
    if (/^[-*]\s+.+/.test(t)) return true;
    if (/^\d+\.\s+.+/.test(t)) return true;
    if (/^#{1,6}\s+.+/.test(t)) return true;
  }
  return false;
}

function norm(s: string | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * Readiness:
 * - draft: no blueprint text in any file
 * - incomplete: some text exists but required bars not met
 * - ready: PROJECT_SPEC, ROADMAP (task-like line), AI_INSTRUCTIONS, CONTEXT non-empty;
 *          at least one of DATA_MODELS or API_DESIGN non-empty;
 *          when schemaVersion === 2, FILE_STRUCTURE.md must also be non-empty (substantive).
 */
export function validateProjectBlueprint(blueprint: ProjectBlueprint | undefined): BlueprintValidationResult {
  const docs = blueprint?.docs ?? {};
  const schema = blueprintEffectiveSchema(blueprint);
  const anyContent = BLUEPRINT_FILE_KEYS.some((k) => norm(docs[k]).length > 0);
  if (!anyContent) {
    return { readiness: "draft", errors: [] };
  }

  const errors: string[] = [];
  const spec = norm(docs["PROJECT_SPEC.md"]);
  const roadmap = norm(docs["ROADMAP.md"]);
  const ai = norm(docs["AI_INSTRUCTIONS.md"]);
  const ctx = norm(docs["CONTEXT.md"]);
  const dm = norm(docs["DATA_MODELS.md"]);
  const api = norm(docs["API_DESIGN.md"]);
  const fileStructure = norm(docs["FILE_STRUCTURE.md"]);

  if (!spec) errors.push("PROJECT_SPEC.md must not be empty.");
  if (!roadmap) errors.push("ROADMAP.md must not be empty.");
  else if (!roadmapHasTaskOrChecklistItem(roadmap)) {
    errors.push(
      "ROADMAP.md must include at least one task or checklist-style line (bullet, numbered item, heading, or - [ ])."
    );
  }
  if (!ai) errors.push("AI_INSTRUCTIONS.md must not be empty.");
  if (!ctx) errors.push("CONTEXT.md must not be empty.");
  if (!dm && !api) {
    errors.push("At least one of DATA_MODELS.md or API_DESIGN.md must be non-empty.");
  }
  if (schema >= 2) {
    if (!fileStructure) {
      errors.push("FILE_STRUCTURE.md must not be empty (required for blueprint schema v2).");
    } else if (fileStructure.length < 20) {
      errors.push("FILE_STRUCTURE.md must be substantive (template or edited content).");
    }
  }

  if (errors.length > 0) {
    return { readiness: "incomplete", errors };
  }
  return { readiness: "ready", errors: [] };
}
