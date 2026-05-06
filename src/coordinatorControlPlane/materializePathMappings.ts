/**
 * Path rules for materializing shared-workspace patches into repo-shaped trees.
 * Supports exact file mappings and prefix (directory) mappings; longest prefix wins among prefix rules.
 */

export type MaterializeMappingPresetId = "none" | "simple_staging" | "team_task_tracker";

export interface PathMappingRule {
  /** Source relative path (no leading slash). For prefix rules, prefer trailing `/` (e.g. `staging/api/`). */
  fromPrefix: string;
  /** Destination: full path for `exact`, or prefix replacement for prefix rules. */
  toPrefix: string;
  /** When true, remap only when the normalized path equals `fromPrefix` (full path match). */
  exact?: boolean;
}

/** Single-rule preset: every file under `staging/` → `db/`. */
export const SIMPLE_STAGING_PATH_MAPPINGS: PathMappingRule[] = [
  { fromPrefix: "staging/", toPrefix: "db/" },
];

/**
 * Team Task Tracker — explicit files first (exact), then directory prefixes (longest wins among prefixes).
 */
export const TEAM_TASK_TRACKER_PATH_MAPPINGS: PathMappingRule[] = [
  { fromPrefix: "staging/schema.sql", toPrefix: "db/schema.sql", exact: true },
  { fromPrefix: "staging/types.ts", toPrefix: "src/shared/types.ts", exact: true },
  { fromPrefix: "staging/routes.ts", toPrefix: "src/api/routes.ts", exact: true },
  { fromPrefix: "staging/api/", toPrefix: "src/api/" },
  { fromPrefix: "staging/components/", toPrefix: "frontend/src/components/" },
  { fromPrefix: "staging/pages/", toPrefix: "frontend/src/pages/" },
];

export interface ResolvedMaterializeMapping {
  preset: MaterializeMappingPresetId | "custom";
  rules: PathMappingRule[];
}

function trimRuleKey(s: string): string {
  return s.trim().replace(/^\/+/, "");
}

/**
 * Apply mapping: exact rules first, then longest matching prefix rule.
 */
export function applyPathMappings(relPath: string, rules: PathMappingRule[]): string {
  const n = relPath.replace(/^\/+/, "");
  if (!rules.length) return n;

  for (const r of rules) {
    if (!r.exact) continue;
    const fp = trimRuleKey(r.fromPrefix);
    const tp = trimRuleKey(r.toPrefix);
    if (fp && n === fp) return tp;
  }

  const prefixRules = rules.filter((r) => !r.exact);
  const sorted = [...prefixRules].sort(
    (a, b) => trimRuleKey(b.fromPrefix).length - trimRuleKey(a.fromPrefix).length
  );
  for (const r of sorted) {
    const fp = trimRuleKey(r.fromPrefix);
    const tp = trimRuleKey(r.toPrefix);
    if (!fp) continue;
    if (n === fp || n.startsWith(fp)) {
      return `${tp}${n.slice(fp.length)}`.replace(/^\/+/, "");
    }
  }

  return n;
}

export function resolveMaterializeMappingFromRequest(body: {
  mappingPreset?: unknown;
  pathMappings?: unknown;
}): ResolvedMaterializeMapping | { error: string } {
  const presetRaw = body.mappingPreset;
  const preset =
    typeof presetRaw === "string"
      ? presetRaw.trim().toLowerCase().replace(/-/g, "_")
      : "";

  const legacy = Array.isArray(body.pathMappings)
    ? body.pathMappings.filter(
        (m): m is PathMappingRule =>
          m != null &&
          typeof m === "object" &&
          typeof (m as PathMappingRule).fromPrefix === "string" &&
          typeof (m as PathMappingRule).toPrefix === "string" &&
          ((m as PathMappingRule).exact === undefined || typeof (m as PathMappingRule).exact === "boolean")
      )
    : [];

  if (preset === "team_task_tracker") {
    return { preset: "team_task_tracker", rules: TEAM_TASK_TRACKER_PATH_MAPPINGS };
  }
  if (preset === "simple_staging") {
    return { preset: "simple_staging", rules: SIMPLE_STAGING_PATH_MAPPINGS };
  }
  if (preset === "none" || preset === "") {
    if (legacy.length > 0) {
      return { preset: "custom", rules: legacy };
    }
    return { preset: "none", rules: [] };
  }

  return {
    error: `Unknown mappingPreset "${String(presetRaw)}". Use none, simple_staging, or team_task_tracker.`,
  };
}
