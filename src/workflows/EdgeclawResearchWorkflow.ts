/**
 * EdgeclawResearchWorkflow
 *
 * Durable topic-research workflow backed by Cloudflare Workflows.
 *
 * Binding key (must match wrangler.jsonc and wf_definitions.entrypoint):
 *   EDGECLAW_RESEARCH_WORKFLOW
 *
 * Architecture:
 *   - Extends AgentWorkflow<MainAgent> for bidirectional RPC with the agent.
 *   - Uses Workers AI for research + report generation.
 *   - Persists the finished report to R2 (SKILLS_BUCKET) under "research/" prefix.
 *   - Supports optional human-in-the-loop approval before the final report is written.
 *
 * Business logic lives in researchWorkflowLogic.ts so it can be unit-tested
 * in plain Node.js without the cloudflare: runtime that AgentWorkflow needs.
 *
 * Steps:
 *   1. initialise       — validate input, record start time
 *   2. gather-sources   — Workers AI researches the topic and extracts insights
 *   [approval?]         — optional human checkpoint
 *   3. synthesise       — Workers AI writes a structured research report
 *   4. save-to-r2       — persist JSON report to SKILLS_BUCKET
 */

import { AgentWorkflow }                        from "agents/workflows";
import type {
  AgentWorkflowEvent,
  AgentWorkflowStep,
  WaitForApprovalOptions,
}                                               from "agents/workflows";
import type { MainAgent }                       from "../agents/MainAgent";
import type { Env }                             from "../lib/env";
import { runResearchWorkflow }                  from "./researchWorkflowLogic";
import type { ResearchParams }                  from "./researchWorkflowLogic";

export type { ResearchParams } from "./researchWorkflowLogic";

// ── Minimal Workers AI interface ───────────────────────────────────────────────
// Workers AI run() can return { response: string } OR a ReadableStream.
// We always pass stream:false and use extractAiText() to coerce to string.

interface WorkersAI {
  run(
    model: string,
    input: {
      messages: Array<{ role: string; content: string }>;
      stream?:  boolean;
    },
  ): Promise<{ response?: unknown } | ReadableStream>;
}

function extractAiText(out: { response?: unknown } | ReadableStream): string {
  if (typeof (out as ReadableStream).getReader === "function") return "";
  const resp = (out as { response?: unknown }).response;
  if (typeof resp === "string") return resp;
  if (resp == null) return "";
  return JSON.stringify(resp);
}

// ── Workflow class ────────────────────────────────────────────────────────────

export class EdgeclawResearchWorkflow extends AgentWorkflow<MainAgent> {
  async run(
    event: AgentWorkflowEvent,
    step:  AgentWorkflowStep,
  ): Promise<unknown> {
    const env = this.env as unknown as Env;

    const result = await runResearchWorkflow(
      event.payload as ResearchParams,
      step,

      {
        // ── Workers AI — research the topic ───────────────────────────────────
        async aiResearch(topic, url) {
          const ai  = env.AI as unknown as WorkersAI;
          const ctx = url ? ` (context URL: ${url})` : "";

          const out = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            stream: false,
            messages: [
              {
                role:    "system",
                content: "You are a knowledgeable research assistant. Always respond with valid JSON only — no markdown fences.",
              },
              {
                role:    "user",
                content: [
                  `Research this topic: "${topic}"${ctx}`,
                  ``,
                  `Return a JSON object with exactly two fields:`,
                  `  "summary"  — one-paragraph overview (≤200 words)`,
                  `  "insights" — array of 4–6 specific, distinct key insight strings`,
                ].join("\n"),
              },
            ],
          });

          const stripped  = extractAiText(out).replace(/```(?:json)?\n?/gi, "").trim();
          const jsonMatch = stripped.match(/\{[\s\S]*\}/);

          if (jsonMatch) {
            try {
              const parsed   = JSON.parse(jsonMatch[0]) as { summary?: string; insights?: string[] };
              const summary  = typeof parsed.summary === "string" ? parsed.summary : stripped;
              const insights = Array.isArray(parsed.insights)
                ? parsed.insights.filter((s): s is string => typeof s === "string")
                : [];
              return { summary, insights };
            } catch { /* fall through */ }
          }

          return { summary: stripped, insights: [] };
        },

        // ── Workers AI — write structured report ──────────────────────────────
        async aiWriteReport(topic, summary, insights) {
          const ai = env.AI as unknown as WorkersAI;

          const out = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            stream: false,
            messages: [
              {
                role:    "system",
                content: "You are a professional research report writer. Use clear headings and bullet points.",
              },
              {
                role:    "user",
                content: [
                  `Write a structured research report on: "${topic}"`,
                  ``,
                  `Summary:`,
                  summary,
                  ``,
                  `Key Insights:`,
                  insights.map((ins, i) => `${i + 1}. ${ins}`).join("\n"),
                  ``,
                  `Format with sections:`,
                  `  ## Overview`,
                  `  ## Key Findings`,
                  `  ## Implications`,
                  `  ## Recommended Next Steps`,
                ].join("\n"),
              },
            ],
          });

          return extractAiText(out);
        },

        // ── R2 — persist ───────────────────────────────────────────────────────
        async persistToR2(topic, reportText) {
          if (!env.SKILLS_BUCKET) {
            // If bucket not bound, return a synthetic key so the workflow
            // doesn't fail — the report is still in the output payload.
            return `research/no-bucket-${Date.now()}.json`;
          }

          const slug = topic
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60);
          const key = `research/${slug}-${Date.now()}.json`;

          await env.SKILLS_BUCKET.put(
            key,
            JSON.stringify({ topic, report: reportText, savedAt: new Date().toISOString() }),
            { httpMetadata: { contentType: "application/json" } },
          );
          return key;
        },

        // ── AgentWorkflow base-class methods ───────────────────────────────────
        reportProgress:  (data) => this.reportProgress(data),
        waitForApproval: (s, opts) =>
          this.waitForApproval(s as AgentWorkflowStep, opts as WaitForApprovalOptions),
      },
    );

    // Notify the agent that the workflow finished successfully.
    // step.reportComplete() wraps the RPC in a durable step.do() so the
    // notification is guaranteed to be delivered even if the agent DO evicts.
    // Without this call, onWorkflowComplete() is NEVER invoked on the agent.
    await step.reportComplete(result);
    return result;
  }
}
