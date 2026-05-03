/**
 * Keep aligned with `src/coordinatorControlPlane/blueprintDocMeta.ts` (client mirror for UI chips).
 */

import type { BlueprintDocSourceState, BlueprintFileKey, ProjectBlueprint } from "../types/coordinatorControlPlane";
import { BLUEPRINT_FILE_KEYS } from "../types/coordinatorControlPlane";

function normalizeDocBody(s: string | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").trim();
}

function roadmapHasTaskOrChecklistItem(markdown: string): boolean {
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

function filePassesValidatedGate(
  key: BlueprintFileKey,
  content: string,
  _allDocs: ProjectBlueprint["docs"]
): boolean {
  const c = normalizeDocBody(content);
  if (!c) return false;
  switch (key) {
    case "PROJECT_SPEC.md":
      return c.length >= 10;
    case "ROADMAP.md":
      return roadmapHasTaskOrChecklistItem(c);
    case "AI_INSTRUCTIONS.md":
    case "CONTEXT.md":
      return c.length >= 20;
    case "DATA_MODELS.md":
    case "API_DESIGN.md":
      return c.length >= 20;
    default:
      return false;
  }
}

export function computeBlueprintDocStates(
  blueprint: Pick<ProjectBlueprint, "docs" | "templateFingerprints">
): Partial<Record<BlueprintFileKey, BlueprintDocSourceState>> {
  const out: Partial<Record<BlueprintFileKey, BlueprintDocSourceState>> = {};
  const docs = blueprint.docs ?? {};
  const fpMap = blueprint.templateFingerprints ?? {};

  for (const k of BLUEPRINT_FILE_KEYS) {
    const raw = docs[k] ?? "";
    const content = normalizeDocBody(raw);
    const fpRaw = fpMap[k];
    const fp = fpRaw !== undefined ? normalizeDocBody(fpRaw) : undefined;

    if (!content) {
      out[k] = "missing";
      continue;
    }
    if (fp !== undefined && content === fp) {
      out[k] = "template_only";
      continue;
    }
    if (filePassesValidatedGate(k, raw, docs)) {
      out[k] = "validated";
    } else {
      out[k] = "edited";
    }
  }
  return out;
}
