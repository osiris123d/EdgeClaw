import { extractChangedPathsFromPatchBody } from "../../coordinatorControlPlane/projectFinalize";

/** Include in task text when canonical repo paths in patches are explicitly required (orchestrator convention). */
export const ALLOW_DIRECT_REPO_PATHS_MARKER = "[ALLOW_DIRECT_REPO_PATHS]";

export function taskAllowsDirectRepoImplementationPaths(task: string | undefined): boolean {
  return typeof task === "string" && /\[\s*ALLOW_DIRECT_REPO_PATHS\s*\]/i.test(task);
}

/** Bypass staging-only enforcement when explicit flag or task marker is present. */
export function implementationPatchPathsPolicyBypass(input: {
  allowImplementationPatchesOutsideStaging?: boolean;
  task: string;
}): boolean {
  return (
    input.allowImplementationPatchesOutsideStaging === true ||
    taskAllowsDirectRepoImplementationPaths(input.task)
  );
}

function normalizeDiffPathToken(raw: string): string {
  let s = raw.trim().replace(/^\/+/, "");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (typeof parsed === "string") s = parsed;
    } catch {
      /* keep quoted form */
    }
  }
  if ((s.startsWith("a/") || s.startsWith("b/")) && s.length > 2) {
    s = s.slice(2);
  }
  return s.replace(/^\/+/, "").trim();
}

/**
 * Returns normalized repo-relative paths that appear in unified diffs but are **not** under `staging/`.
 * Used for coding-loop policy (implementation patches should target staging until materialization).
 */
export function collectNonStagingImplementationPaths(patchBodies: string[]): string[] {
  const bad = new Set<string>();
  for (const body of patchBodies) {
    if (!body.trim()) continue;
    for (const raw of extractChangedPathsFromPatchBody(body)) {
      const n = normalizeDiffPathToken(raw);
      if (!n || n === "dev/null") continue;
      if (!n.startsWith("staging/")) bad.add(n);
    }
  }
  return [...bad].sort();
}

/** Appended to coder turns from the coding-loop manager (and mirrored in CoderAgent soul prompt). */
export const CODER_IMPLEMENTATION_PATH_POLICY_MARKDOWN =
  "\n--- Implementation paths (control-plane / shared workspace) ---\n" +
  "- **FILE_STRUCTURE.md** (when present in the blueprint bundle) is the source of truth for where staged files live and how they map to final repo paths.\n" +
  "- Put **implementation** output under **staging/<logical-path>** aligned with FILE_STRUCTURE.md (e.g. `staging/schema.sql`, `staging/api/handlers.ts`).\n" +
  "- **shared_workspace_put_patch** unified diffs must use **`staging/`** paths — **not** canonical repo roots such as `src/`, `frontend/`, `db/`, etc., unless FILE_STRUCTURE.md or the task explicitly allows it.\n" +
  "- Materialization maps `staging/…` into real repo paths; do not invent layout beyond the blueprint.\n" +
  "- Exception: only when the task includes the literal marker **" +
  ALLOW_DIRECT_REPO_PATHS_MARKER +
  "** may patches target canonical paths directly (unless FILE_STRUCTURE.md explicitly documents broader exceptions).\n";

/** Appended to tester prompts from the coding-loop manager (and mirrored in TesterAgent soul prompt). */
export const TESTER_IMPLEMENTATION_PATH_POLICY_MARKDOWN =
  "\n--- Implementation path hygiene (control-plane work) ---\n" +
  "- Use **FILE_STRUCTURE.md** from the blueprint bundle (when present) as the contract for staged vs canonical placement.\n" +
  "- Pending **implementation** patches must **only** touch paths under **`staging/`** unless FILE_STRUCTURE.md or the task explicitly permits canonical targets.\n" +
  "- Canonical roots (`src/`, `frontend/`, `db/`, …) are **not allowed** unless the task text includes `" +
  ALLOW_DIRECT_REPO_PATHS_MARKER +
  "` **or** FILE_STRUCTURE.md clearly documents an exception for those paths.\n" +
  "- If scoped patches **mix** `staging/…` with non-staging paths without permission → **VERDICT: FAIL** and list the offending paths.\n";
