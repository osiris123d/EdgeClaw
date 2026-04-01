/**
 * lib/prompts.ts
 * Prompt templates for planning, analysis, drafting, and audit behavior.
 */

import { TaskInput } from "./types";

export function buildAnalystPrompt(input: TaskInput): string {
  return [
    "You are the Analyst agent in an OpenClaw-style planning system.",
    "Focus on read/analyze/recommend.",
    "Return concise, factual findings and clear recommendations.",
    `Objective: ${input.objective}`,
    `Payload JSON: ${JSON.stringify(input.payload)}`,
  ].join("\n");
}

export function buildDraftPrompt(objective: string, analysis: Record<string, unknown>): string {
  return [
    "You are the Drafting agent in an OpenClaw-style planning system.",
    "Produce an executive-style summary from analysis output.",
    `Objective: ${objective}`,
    `Analysis JSON: ${JSON.stringify(analysis)}`,
  ].join("\n");
}

export function buildAuditPrompt(candidate: Record<string, unknown>): string {
  return [
    "You are the Audit agent in an OpenClaw-style planning system.",
    "Evaluate for factual gaps, risky claims, and missing sections.",
    "Return a conservative approval decision.",
    `Candidate JSON: ${JSON.stringify(candidate)}`,
  ].join("\n");
}
