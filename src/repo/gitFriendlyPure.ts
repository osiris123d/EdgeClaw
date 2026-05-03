/**
 * Pure, deterministic helpers — safe in Workers with no git binary.
 * Shared workspace patch bodies pass through here for git-friendly export formatting.
 */

const MAX_BRANCH_SEGMENT = 48;
const MAX_COMMIT_LINE = 72;
const DEFAULT_SUMMARY_LINES = 40;

function slugSegment(s: string, maxLen: number): string {
  const t = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return t.slice(0, maxLen) || "task";
}

/** Suggest a conventional branch name (no git mutation). */
export function suggestBranchName(taskSummary: string, projectId: string): string {
  const task = slugSegment(taskSummary.trim() || "change", MAX_BRANCH_SEGMENT);
  const proj = slugSegment(projectId.trim() || "proj", 24);
  return `feat/${proj}-${task}`;
}

/** Suggest a single-line conventional commit subject (no git mutation). */
export function suggestCommitMessageSubject(summary: string): string {
  const line = summary.trim().split(/\r?\n/)[0] ?? "";
  const cleaned = line.replace(/\s+/g, " ").trim();
  const subject = cleaned.slice(0, MAX_COMMIT_LINE);
  return subject || "chore: update shared workspace proposal";
}

/** Truncate + annotate a unified diff for LLM-facing summaries. */
export function summarizeDiffText(diffText: string, maxLines: number = DEFAULT_SUMMARY_LINES): string {
  const lines = diffText.split(/\r?\n/);
  const head = lines.slice(0, maxLines).join("\n");
  const rest = lines.length - maxLines;
  if (rest <= 0) {
    return head;
  }
  return `${head}\n\n… (${rest} more lines omitted)`;
}

/** Heuristic: treat as unified diff if it looks like patch text. */
export function looksLikeUnifiedDiff(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /^diff --git\s/m.test(t) ||
    (/^---\s/m.test(t) && /^\+\+\+\s/m.test(t)) ||
    /^@@\s/m.test(t)
  );
}

/**
 * Wrap arbitrary proposal body as a git-friendly fragment (for export only).
 * If already unified diff, returns unchanged.
 */
export function normalizeProposalToGitFriendlyPatch(
  body: string,
  suggestedPath: string
): string {
  const b = body.trimEnd();
  if (looksLikeUnifiedDiff(b)) {
    return b.endsWith("\n") ? b : `${b}\n`;
  }
  const path = suggestedPath.replace(/^\/+/, "") || "proposal.txt";
  return (
    `# edgeclaw-export: synthetic fragment (attach to real paths when applying with git apply)\n` +
    `diff --git a/${path} b/${path}\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@\n` +
    `${b.split(/\r?\n/).join("\n")}\n`
  );
}
