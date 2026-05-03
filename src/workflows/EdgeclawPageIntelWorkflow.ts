/**
 * EdgeclawPageIntelWorkflow
 *
 * A durable multi-step "page intelligence" workflow that chains three real
 * Cloudflare services together:
 *
 *   1. Browser Rendering (BROWSER binding + @cloudflare/puppeteer)
 *      → scrapes the target URL and returns visible text
 *
 *   2. Workers AI (AI binding, @cf/meta/llama-3.3-70b-instruct-fp8-fast)
 *      → step A: summarise the page and extract key insights (JSON output)
 *      → step B: write a structured research report (prose output)
 *
 *   3. R2 (SKILLS_BUCKET binding)
 *      → persists the finished report as JSON under the "intel/" prefix
 *
 *   4. Human-in-the-loop approval (AgentWorkflow.waitForApproval)
 *      → optional checkpoint between analyse and write-report;
 *        visible in the Workflows UI inspector drawer
 *
 * Binding key:  EDGECLAW_PAGE_INTEL_WORKFLOW
 * wrangler.jsonc name: edgeclaw-page-intel-workflow
 *
 * All business logic lives in pageIntelWorkflowLogic.ts so it can be
 * unit-tested in plain Node.js without the cloudflare: runtime.
 */

import puppeteer from "@cloudflare/puppeteer";
import { AgentWorkflow }                                            from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep,
              WaitForApprovalOptions }                              from "agents/workflows";
import type { MainAgent }                                           from "../agents/MainAgent";
import type { Env }                                                 from "../lib/env";
import { runPageIntelWorkflow }                                     from "./pageIntelWorkflowLogic";
import type { PageIntelParams }                                     from "./pageIntelWorkflowLogic";

export type { PageIntelParams } from "./pageIntelWorkflowLogic";

// ── Minimal Workers AI interface ──────────────────────────────────────────────
// env.AI is typed as `unknown`; we cast to this narrow interface at the call site.
// Workers AI run() can return { response: string } OR a ReadableStream depending
// on model + whether streaming is triggered.  We always pass stream:false and
// use extractAiText() to safely coerce whatever comes back into a string.

interface WorkersAI {
  run(
    model: string,
    input: {
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
    },
  ): Promise<{ response?: unknown } | ReadableStream>;
}

/**
 * Safely extract a text string from a Workers AI response.
 *
 * Handles all observed return shapes:
 *   { response: string }  — standard non-streaming response
 *   { response: object }  — unexpected but real: JSON-stringify it
 *   ReadableStream        — streaming was triggered despite stream:false; returns ""
 *   string                — the rare case where the binding returns bare text
 */
function extractAiText(out: { response?: unknown } | ReadableStream): string {
  // ReadableStream has getReader(); plain objects don't.
  if (typeof (out as ReadableStream).getReader === "function") return "";
  const resp = (out as { response?: unknown }).response;
  if (typeof resp === "string") return resp;
  if (resp == null) return "";
  // Unexpected object shape — best-effort serialise so the caller has something.
  return JSON.stringify(resp);
}

// ── Workflow class ────────────────────────────────────────────────────────────

export class EdgeclawPageIntelWorkflow extends AgentWorkflow<MainAgent> {
  async run(
    event: AgentWorkflowEvent,
    step:  AgentWorkflowStep,
  ): Promise<unknown> {
    const env = this.env as unknown as Env;

    const result = await runPageIntelWorkflow(
      event.payload as PageIntelParams,
      step,

      // ── Service implementations ─────────────────────────────────────────────

      {
        // ── Browser Rendering ───────────────────────────────────────────────
        async fetchPageContent(url) {
          if (!env.BROWSER) throw new Error("BROWSER binding not configured");

          // @cloudflare/puppeteer launched with the BROWSER Fetcher binding.
          // The browser.close() is always called (finally block) so the
          // Browser Rendering session is not left open if later steps throw.
          const browser = await puppeteer.launch(env.BROWSER);
          try {
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            const title    = await page.title();
            // Limit to 8 000 chars so the AI prompt stays within context limits.
            const bodyText = await page.evaluate(
              // This callback runs inside the browser tab — cast to satisfy tsc
              // which has no DOM lib in the Workers tsconfig.
              () => (((globalThis as unknown as { document: { body: { innerText: string } } })
                .document.body.innerText) ?? "").slice(0, 8_000),
            ) as string;
            return { title, bodyText };
          } finally {
            await browser.close();
          }
        },

        // ── Workers AI — summarise ──────────────────────────────────────────
        async aiSummarize(bodyText, url) {
          const ai = env.AI as unknown as WorkersAI;
          const out = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            stream: false,
            messages: [
              {
                role:    "system",
                content: "You are a concise research assistant. Always respond with valid JSON only — no markdown fences.",
              },
              {
                role:    "user",
                content: [
                  `Analyse this web content fetched from ${url}.`,
                  `Return a JSON object with exactly two fields:`,
                  `  "summary"  — one-paragraph overview (≤200 words)`,
                  `  "insights" — array of 3–5 specific key insight strings`,
                  ``,
                  `Content:`,
                  bodyText,
                ].join("\n"),
              },
            ],
          });

          // Strip markdown fences then fish out the first {...} block.
          // Models sometimes prefix the JSON with a short preamble sentence;
          // a targeted regex is more reliable than parsing the whole string.
          const stripped = extractAiText(out).replace(/```(?:json)?\n?/gi, "").trim();
          const jsonMatch = stripped.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; insights?: string[] };
              const summary  = typeof parsed.summary  === "string" ? parsed.summary  : stripped;
              const insights = Array.isArray(parsed.insights)
                ? parsed.insights.filter((s): s is string => typeof s === "string")
                : [];
              return { summary, insights };
            } catch { /* fall through to plain-text fallback */ }
          }
          // Plain-text fallback: treat the whole response as the summary.
          return { summary: stripped, insights: [] };
        },

        // ── Workers AI — write report ───────────────────────────────────────
        async aiWriteReport(summary, insights, url) {
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
                  `Write a structured research report for: ${url}`,
                  ``,
                  `Summary:`,
                  summary,
                  ``,
                  `Key Insights:`,
                  insights.map((ins, i) => `${i + 1}. ${ins}`).join("\n"),
                  ``,
                  `Format with sections:`,
                  `  ## Executive Summary`,
                  `  ## Key Findings`,
                  `  ## Implications`,
                  `  ## Recommended Next Steps`,
                ].join("\n"),
              },
            ],
          });
          return extractAiText(out);
        },

        // ── R2 — persist ────────────────────────────────────────────────────
        async persistToR2(url, reportText) {
          if (!env.SKILLS_BUCKET) throw new Error("SKILLS_BUCKET binding not configured");

          // Build a readable, filesystem-safe key from the URL + timestamp.
          const slug = url
            .replace(/^https?:\/\//i, "")
            .replace(/[^a-zA-Z0-9]/g, "-")
            .replace(/-{2,}/g, "-")
            .slice(0, 80);
          const key = `intel/${slug}-${Date.now()}.json`;

          await env.SKILLS_BUCKET.put(
            key,
            JSON.stringify({ url, report: reportText, savedAt: new Date().toISOString() }),
            { httpMetadata: { contentType: "application/json" } },
          );
          return key;
        },

        // ── AgentWorkflow base-class methods ────────────────────────────────
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
