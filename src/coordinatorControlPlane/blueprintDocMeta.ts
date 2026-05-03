import { roadmapHasTaskOrChecklistItem } from "./blueprintValidation";
import type { BlueprintDocSourceState, BlueprintFileKey, ProjectBlueprint } from "./types";
import { BLUEPRINT_FILE_KEYS } from "./types";

function normalizeDocBody(s: string | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").trim();
}

/** Per-file bar for marking a doc `validated` (stricter than project “ready”). */
export function filePassesValidatedGate(
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

/**
 * - missing: empty
 * - template_only: matches last generated fingerprint (scaffold)
 * - validated: differs from fingerprint and passes per-file gate
 * - edited: differs from fingerprint but does not yet pass gate
 */
export function computeBlueprintDocStates(blueprint: ProjectBlueprint): Partial<
  Record<BlueprintFileKey, BlueprintDocSourceState>
> {
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

export function withComputedDocState(blueprint: ProjectBlueprint): ProjectBlueprint {
  return {
    ...blueprint,
    docState: computeBlueprintDocStates(blueprint),
  };
}
