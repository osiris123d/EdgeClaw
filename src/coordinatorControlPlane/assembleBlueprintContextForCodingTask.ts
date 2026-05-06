/**
 * Task-scoped blueprint → markdown for coder/tester prompts.
 * Falls back to {@link formatBlueprintContextForPrompt} when excerpts are too thin vs total blueprint size.
 * Future: replace keyword blocks with retrieval / LLM summarization; keep the same export shape.
 */

import type { ProjectBlueprintContextPackage } from "./projectBlueprintOrchestrationContext";
import { formatBlueprintContextForPrompt } from "./projectBlueprintOrchestrationContext";

export type BlueprintAssemblyMode = "task_scoped" | "full_fallback";

const MAX_TOTAL_CHARS = 26_000;
const MIN_EXCERPT_BODY_CHARS = 420;
const SMALL_PROJECT_TOTAL = 1_600;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "your",
  "you",
  "are",
  "was",
  "has",
  "have",
  "not",
  "use",
  "via",
  "one",
  "all",
  "any",
  "can",
  "may",
  "will",
  "must",
  "should",
  "when",
  "what",
  "which",
  "each",
  "only",
  "also",
  "than",
  "then",
  "them",
  "they",
  "their",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tokens from backticks plus alphanumeric words (≥3 chars), de-duplicated. */
export function extractTaskKeywords(task: string): string[] {
  const out: string[] = [];
  const tick = task.match(/`([^`]+)`/g) ?? [];
  for (const t of tick) {
    const inner = t.slice(1, -1).trim().toLowerCase();
    if (inner.length >= 2) out.push(inner);
  }
  const rest = task.toLowerCase().replace(/`[^`]*`/g, " ");
  const words = rest.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  for (const w of words) {
    if (!STOPWORDS.has(w)) out.push(w);
  }
  return [...new Set(out)];
}

function scoreBlock(block: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const low = block.toLowerCase();
  let s = 0;
  for (const kw of keywords) {
    if (kw.length < 2) continue;
    const re = new RegExp(escapeRegExp(kw), "gi");
    const matches = low.match(re);
    if (matches) {
      s += matches.length * (1 + Math.min(kw.length / 8, 2));
    }
  }
  return s;
}

function excerptByKeywords(full: string, keywords: string[], maxChars: number): string {
  const trimmed = full.trim();
  if (!trimmed) return "";
  const blocks = trimmed
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return trimmed.slice(0, maxChars);

  const scored = blocks.map((b) => ({ b, s: scoreBlock(b, keywords) }));
  scored.sort((a, b) => b.s - a.s);

  const picked: string[] = [];
  let n = 0;
  for (const { b } of scored) {
    if (n >= maxChars) break;
    const sep = picked.length ? "\n\n" : "";
    if (n + sep.length + b.length > maxChars) {
      const room = maxChars - n - sep.length;
      if (room > 120) {
        picked.push(b.slice(0, room) + "…");
      }
      break;
    }
    picked.push(b);
    n += sep.length + b.length;
  }
  let body = picked.join("\n\n").trim();
  if (!body && trimmed.length) {
    body = trimmed.slice(0, maxChars);
  }
  if (body.length > maxChars) body = body.slice(0, maxChars);
  return body;
}

function totalBlueprintChars(pkg: ProjectBlueprintContextPackage): number {
  const d = pkg.blueprint;
  return (
    d.projectSpec.length +
    d.roadmap.length +
    d.dataModels.length +
    d.apiDesign.length +
    d.aiInstructions.length +
    d.context.length +
    d.fileStructure.length
  );
}

function taskHintsFileStructure(task: string): boolean {
  return /\b(file|path|paths|staging|repo|frontend|back[- ]?end|database|\bdb\b|schema|route|routes|component|layout|directory|directories|folder)\b/i.test(
    task
  );
}

function formatIdentitySection(pkg: ProjectBlueprintContextPackage): string {
  const ve =
    pkg.validationErrors && pkg.validationErrors.length > 0
      ? `\n- **validationErrors (registry):** ${pkg.validationErrors.join("; ")}`
      : "";
  return (
    `## Project identity\n` +
    `- **projectId (control plane):** ${pkg.projectId}\n` +
    `- **projectName:** ${pkg.projectName}\n` +
    `- **projectSlug:** ${pkg.projectSlug}\n` +
    `- **sharedProjectId (workspace):** ${pkg.sharedProjectId}\n` +
    `- **readiness:** ${pkg.readiness}${ve}\n`
  );
}

/**
 * Build markdown for one coding-loop task from a structured blueprint package.
 * Uses keyword overlap over paragraph blocks; falls back to full formatted blueprint when excerpts are too thin.
 */
export function assembleBlueprintContextForCodingTask(
  pkg: ProjectBlueprintContextPackage,
  task: string
): { markdown: string; mode: BlueprintAssemblyMode } {
  const total = totalBlueprintChars(pkg);
  const keywords = extractTaskKeywords(task);

  const sections: { title: string; body: string; budget: number }[] = [
    { title: "PROJECT_SPEC (excerpts)", body: pkg.blueprint.projectSpec, budget: 5_500 },
    { title: "ROADMAP (excerpts)", body: pkg.blueprint.roadmap, budget: 2_200 },
    { title: "DATA_MODELS (excerpts)", body: pkg.blueprint.dataModels, budget: 2_800 },
    { title: "API_DESIGN (excerpts)", body: pkg.blueprint.apiDesign, budget: 2_800 },
    { title: "AI_INSTRUCTIONS (excerpts)", body: pkg.blueprint.aiInstructions, budget: 5_000 },
    { title: "CONTEXT (excerpts)", body: pkg.blueprint.context, budget: 3_200 },
  ];

  const parts: string[] = [
    "## Task-scoped blueprint (coordinator-assembled v1)",
    "",
    formatIdentitySection(pkg),
    "",
    "### Task keywords used for relevance",
    keywords.length ? keywords.map((k) => `- \`${k}\``).join("\n") : "(none — full-doc fallback likely)",
    "",
  ];

  let excerptScoreSum = 0;
  let excerptBodyLen = 0;

  for (const { title, body, budget } of sections) {
    const excerpt = excerptByKeywords(body, keywords, budget);
    if (!excerpt.trim()) continue;
    const sc = scoreBlock(excerpt, keywords);
    excerptScoreSum += sc;
    parts.push(`## ${title}`);
    parts.push(excerpt);
    parts.push("");
    excerptBodyLen += excerpt.length;
  }

  const fsBody = pkg.blueprint.fileStructure.trim();
  if (fsBody) {
    const fsBudget = taskHintsFileStructure(task) ? 5_000 : 3_200;
    let fsExcerpt = excerptByKeywords(fsBody, keywords, fsBudget);
    if (fsExcerpt.length < 400 && fsBody.length > fsExcerpt.length) {
      fsExcerpt = fsBody.slice(0, Math.min(fsBudget, fsBody.length));
    }
    excerptScoreSum += scoreBlock(fsExcerpt, keywords);
    parts.push(`## FILE_STRUCTURE.md (excerpts)`);
    parts.push(fsExcerpt);
    parts.push("");
    excerptBodyLen += fsExcerpt.length;
  }

  let markdown = parts.join("\n").trim();

  const useFullFallback =
    total > SMALL_PROJECT_TOTAL &&
    (keywords.length === 0 ||
      excerptBodyLen < MIN_EXCERPT_BODY_CHARS ||
      excerptScoreSum < 1.5);

  if (useFullFallback) {
    return { markdown: formatBlueprintContextForPrompt(pkg), mode: "full_fallback" };
  }

  if (markdown.length > MAX_TOTAL_CHARS) {
    markdown =
      markdown.slice(0, MAX_TOTAL_CHARS) +
      `\n\n… (truncated to ${MAX_TOTAL_CHARS} chars; full docs remain in control-plane KV.)`;
  }

  return { markdown, mode: "task_scoped" };
}
