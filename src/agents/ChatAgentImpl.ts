import { getCurrentAgent } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { DispatcherAgent } from "./DispatcherAgent";
import { getAccessIdentity } from "../lib/auth";
import { getTask } from "../lib/r2";
import type { Env } from "../lib/types";

/**
 * Minimal Phase 1 Cloudflare Agents SDK integration.
 *
 * Important boundary in this phase:
 * - AIChatAgent manages chat history/state in Durable Object SQLite automatically.
 * - Existing EdgeClaw task execution remains unchanged (Dispatcher -> TaskCoordinatorDO -> Workflow -> R2 artifacts/worklogs).
 * - Existing R2 chat routes are not removed or cut over yet.
 */
export class ChatAgentImpl extends AIChatAgent {
  async onChatMessage(_onFinish?: unknown, options?: { body?: Record<string, unknown> }): Promise<Response> {
    const env = (this as unknown as { env: Env }).env;
    const content = extractLatestUserText(this.messages as unknown[]);

    if (!content) {
      return textResponse("I could not find a user message to process.");
    }

    const requestedTaskId = extractTaskIdFromText(content);
    if (requestedTaskId && isStatusQuery(content)) {
      const task = await getTask(env.R2_ARTIFACTS, requestedTaskId);
      if (!task) {
        return textResponse(`I could not find task ${requestedTaskId}.`);
      }

      return textResponse(
        [
          `Task ${task.taskId} is currently ${task.status}.`,
          `Approval state: ${task.approvalState}.`,
          `Type/domain: ${task.taskType}/${task.domain}.`,
        ].join(" ")
      );
    }

    if (isTaskLikeMessage(content)) {
      const { request } = getCurrentAgent();
      const accessIdentity = request ? getAccessIdentity(request) : null;
      const userId = accessIdentity?.userId ?? resolveUserId(options?.body);
      const dispatcher = new DispatcherAgent();
      const routed = await dispatcher.handleInboundRequest(env, {
        userId,
        text: content,
        source: "chat",
        startWorkflow: false,
      });

      if (routed.ok && routed.taskId) {
        return textResponse(
          [
            `I created task ${routed.taskId}.`,
            `Classification: ${routed.taskType}/${routed.domain} with confidence ${(routed.confidence ?? 0).toFixed(2)}.`,
            `Use \"status ${routed.taskId}\" to check progress.`,
          ].join(" ")
        );
      }

      return textResponse(
        `I could not create a task from that request: ${routed.error ?? routed.reason ?? "unknown dispatcher error"}.`
      );
    }

    return textResponse(
      [
        "I can turn task-style requests into queued work items.",
        "Examples:",
        "- Draft CAB notes for a NAC policy rollback",
        "- Summarize this WiFi outage for leadership",
        "- Create a weekly network report draft",
        "- Status task-123",
      ].join(" ")
    );
  }
}

function textResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function resolveUserId(body?: Record<string, unknown>): string {
  if (!body) return "anonymous-user";
  const value = body.userId;
  return typeof value === "string" && value.trim() ? value.trim() : "anonymous-user";
}

function extractLatestUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = toRecord(messages[i]);
    if (!msg || msg.role !== "user") continue;

    const content = msg.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const textParts = parts
      .map((part) => {
        const rec = toRecord(part);
        if (!rec || rec.type !== "text") return "";
        return typeof rec.text === "string" ? rec.text : "";
      })
      .filter(Boolean);

    const joined = textParts.join(" ").trim();
    if (joined) return joined;
  }

  return "";
}

function isTaskLikeMessage(content: string): boolean {
  const text = content.toLowerCase();
  return /(draft|summarize|summary|review|analy|assess|investig|audit|report|triage|incident|status)/.test(text);
}

function isStatusQuery(content: string): boolean {
  const text = content.toLowerCase();
  return /(status|state|progress|where is|check)/.test(text);
}

function extractTaskIdFromText(content: string): string | null {
  const match = content.match(/\btask-[a-z0-9-]+\b/i);
  return match ? match[0] : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}
