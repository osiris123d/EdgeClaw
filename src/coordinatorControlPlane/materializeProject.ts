import { applyPatch, parsePatch } from "diff";
import type { StructuredPatch } from "diff";
import type { PathMappingRule } from "./materializePathMappings";
import { applyPathMappings } from "./materializePathMappings";

export type {
  MaterializeMappingPresetId,
  PathMappingRule,
  ResolvedMaterializeMapping,
} from "./materializePathMappings";
export {
  applyPathMappings,
  resolveMaterializeMappingFromRequest,
  SIMPLE_STAGING_PATH_MAPPINGS,
  TEAM_TASK_TRACKER_PATH_MAPPINGS,
} from "./materializePathMappings";

export interface MaterializePatchInput {
  patchId: string;
  updatedAt: string;
  body: string;
}

export interface MaterializeConflict {
  patchId: string;
  path: string;
  detail: string;
}

export interface MaterializeSkipped {
  patchId: string;
  path?: string;
  reason: string;
}

export interface MaterializePreviewRow {
  sourcePath: string;
  destinationPath: string;
  patchId: string;
  status: "applied" | "conflict" | "skipped";
  detail?: string;
}

export interface MaterializeFromPatchesResult {
  /** Relative POSIX paths → UTF-8 file bodies */
  files: Map<string, string>;
  conflicts: MaterializeConflict[];
  skipped: MaterializeSkipped[];
  previewRows: MaterializePreviewRow[];
}

const PARSE_ERROR_SNIPPET_MAX = 420;

/**
 * Agents often wrap unified diffs in markdown fences; `diff` `parsePatch` expects raw diff text.
 * Strips a leading ```lang block (optional closing ```); otherwise returns trimmed body.
 */
export function normalizePatchBodyForParse(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "").trimStart();
  if (!s.startsWith("```")) {
    return s.trimEnd();
  }
  const firstNl = s.indexOf("\n");
  if (firstNl === -1) {
    return s.trim();
  }
  s = s.slice(firstNl + 1);
  const close = s.lastIndexOf("\n```");
  if (close !== -1) {
    s = s.slice(0, close);
  } else if (s.trimEnd().endsWith("```")) {
    s = s.trimEnd().slice(0, -3).trimEnd();
  }
  return s.trim();
}

function formatParsePatchFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message.trim() : String(err).trim();
  const core = msg.length ? msg.slice(0, PARSE_ERROR_SNIPPET_MAX) : "(no message)";
  return msg.length > PARSE_ERROR_SNIPPET_MAX ? `${core}…` : core;
}

/** Captures unified-diff @@ header; groups 1/3 are starts, 2/4 optional legacy counts (ignored by repair). */
const UNIFIED_HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Counts hunk lines the same way `diff` `parsePatch` does (`+` / `-` / context ` `; `\` meta; blank→context except EOF).
 */
function scanUnifiedHunkBodyForRepair(
  lines: readonly string[],
  start: number
): { end: number; oldLines: number; newLines: number } {
  let i = start;
  let removeCount = 0;
  let addCount = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^@@ /.test(line)) break;
    if (/^diff --git /.test(line)) break;

    const operation =
      line.length === 0 && i !== lines.length - 1 ? " " : line.charAt(0);
    if (operation === "+") {
      addCount++;
      i++;
      continue;
    }
    if (operation === "-") {
      removeCount++;
      i++;
      continue;
    }
    if (operation === " ") {
      addCount++;
      removeCount++;
      i++;
      continue;
    }
    if (operation === "\\") {
      i++;
      continue;
    }
    break;
  }
  return { end: i, oldLines: removeCount, newLines: addCount };
}

/**
 * LLM-authored unified diffs often declare wrong `@@ -old,n +new,m @@` counts. Rebuild each header from the following
 * body lines so `parsePatch` accepts the patch (materialization-only normalization).
 */
export function repairUnifiedDiffHunkHeaders(raw: string): string {
  const normalizedEOL = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = UNIFIED_HUNK_HEADER_RE.exec(line);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    const oldStart = m[1]!;
    const newStart = m[3]!;
    const suffix = m[5] ?? "";
    const bodyStart = i + 1;
    const { end, oldLines, newLines } = scanUnifiedHunkBodyForRepair(lines, bodyStart);
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${suffix}`);
    for (let j = bodyStart; j < end; j++) {
      out.push(lines[j]!);
    }
    i = end;
  }
  return out.join(normalizedEOL);
}

function parsePatchWithOptionalRepair(trimmed: string): StructuredPatch[] {
  try {
    return parsePatch(trimmed);
  } catch {
    return parsePatch(repairUnifiedDiffHunkHeaders(trimmed));
  }
}

export function normalizePatchFilePath(raw: string | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === "" || t === "/dev/null") return null;
  let s = t;
  if ((s.startsWith("a/") || s.startsWith("b/")) && s.length > 2) {
    s = s.slice(2);
  }
  const cleaned = s.replace(/^\/+/, "");
  if (!cleaned || cleaned.split("/").some((p) => p === "..")) return null;
  return cleaned;
}

function logicalDisplaySource(sp: StructuredPatch): string | null {
  const preferNew = sp.newFileName && sp.newFileName !== "/dev/null";
  const raw = preferNew ? sp.newFileName : sp.oldFileName;
  return normalizePatchFilePath(raw);
}

function resolveTargetPath(sp: StructuredPatch, mappings: PathMappingRule[]): string | null {
  const preferNew = sp.newFileName && sp.newFileName !== "/dev/null";
  const raw = preferNew ? sp.newFileName : sp.oldFileName;
  const base = normalizePatchFilePath(raw);
  if (!base) return null;
  return applyPathMappings(base, mappings);
}

function resolveOldPath(sp: StructuredPatch, mappings: PathMappingRule[]): string | null {
  const raw = sp.oldFileName;
  const base = normalizePatchFilePath(raw);
  if (!base) return null;
  return applyPathMappings(base, mappings);
}

/**
 * Merge applied patch bodies in chronological order using `diff`’s unified-diff applier.
 * Conflicts: when `applyPatch` returns `false`, that patch file-op is skipped and prior content kept.
 */
export function materializeFromAppliedPatches(
  patches: MaterializePatchInput[],
  pathMappings: PathMappingRule[]
): MaterializeFromPatchesResult {
  const files = new Map<string, string>();
  const conflicts: MaterializeConflict[] = [];
  const skipped: MaterializeSkipped[] = [];
  const previewRows: MaterializePreviewRow[] = [];

  const ordered = [...patches].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  for (const { patchId, body } of ordered) {
    const trimmed = normalizePatchBodyForParse(body);
    if (!trimmed) {
      skipped.push({ patchId, reason: "empty_patch_body" });
      previewRows.push({
        sourcePath: "—",
        destinationPath: "—",
        patchId,
        status: "skipped",
        detail: "empty_patch_body",
      });
      continue;
    }

    let structured: StructuredPatch[];
    try {
      structured = parsePatchWithOptionalRepair(trimmed);
    } catch (e) {
      const hint = formatParsePatchFailure(e);
      skipped.push({ patchId, reason: `parsePatch_failed: ${hint}` });
      previewRows.push({
        sourcePath: "—",
        destinationPath: "—",
        patchId,
        status: "skipped",
        detail: `parsePatch_failed: ${hint}`,
      });
      continue;
    }

    if (!structured.length) {
      skipped.push({ patchId, reason: "no_structured_indices" });
      previewRows.push({
        sourcePath: "—",
        destinationPath: "—",
        patchId,
        status: "skipped",
        detail: "no_structured_indices",
      });
      continue;
    }

    for (const sp of structured) {
      const srcDisp = logicalDisplaySource(sp) ?? "—";

      if (sp.isBinary) {
        const destGuess =
          resolveTargetPath(sp, pathMappings) ?? resolveOldPath(sp, pathMappings) ?? "—";
        skipped.push({
          patchId,
          path: destGuess !== "—" ? destGuess : undefined,
          reason: "binary_patch_not_supported",
        });
        previewRows.push({
          sourcePath: srcDisp,
          destinationPath: destGuess,
          patchId,
          status: "skipped",
          detail: "binary_patch_not_supported",
        });
        continue;
      }

      if (sp.isRename || sp.isCopy) {
        const oldSrc = normalizePatchFilePath(sp.oldFileName) ?? "—";
        const newSrc = normalizePatchFilePath(sp.newFileName) ?? "—";
        skipped.push({
          patchId,
          reason: sp.isRename ? "rename_not_supported_use_manual_export" : "copy_not_supported",
        });
        previewRows.push({
          sourcePath: oldSrc,
          destinationPath: newSrc,
          patchId,
          status: "skipped",
          detail: sp.isRename ? "rename_not_supported" : "copy_not_supported",
        });
        continue;
      }

      if (sp.isDelete) {
        const baseOld = normalizePatchFilePath(sp.oldFileName);
        const delPath = baseOld ? applyPathMappings(baseOld, pathMappings) : null;
        if (delPath) files.delete(delPath);
        previewRows.push({
          sourcePath: baseOld ?? "—",
          destinationPath: delPath ?? "—",
          patchId,
          status: "applied",
          detail: "file_deleted",
        });
        continue;
      }

      const path = resolveTargetPath(sp, pathMappings);
      if (!path) {
        skipped.push({ patchId, reason: "could_not_resolve_target_path" });
        previewRows.push({
          sourcePath: srcDisp,
          destinationPath: "—",
          patchId,
          status: "skipped",
          detail: "could_not_resolve_target_path",
        });
        continue;
      }

      const prior = files.get(path) ?? "";

      const applied = applyPatch(prior, sp, { fuzzFactor: 0 });
      if (applied === false) {
        const detail =
          "applyPatch_failed — hunk context did not match accumulated file (another patch may have changed overlapping lines). Prior content kept.";
        conflicts.push({
          patchId,
          path,
          detail,
        });
        previewRows.push({
          sourcePath: normalizePatchFilePath(sp.newFileName ?? sp.oldFileName) ?? srcDisp,
          destinationPath: path,
          patchId,
          status: "conflict",
          detail,
        });
        continue;
      }

      files.set(path, applied);
      previewRows.push({
        sourcePath: normalizePatchFilePath(sp.newFileName ?? sp.oldFileName) ?? srcDisp,
        destinationPath: path,
        patchId,
        status: "applied",
      });
    }
  }

  return { files, conflicts, skipped, previewRows };
}
