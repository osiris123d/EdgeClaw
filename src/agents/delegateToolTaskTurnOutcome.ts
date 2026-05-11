/**
 * Pure outcomes for `delegate_tool_task` — shared by {@link MainAgent} and Node tests.
 * Keeps failure/bootstrap copy and latch derivation identical without importing Think.
 */

import { TOOL_AGENT_MCP_RESTORE_FAILED_PREFIX } from "../lib/mcpRestoreFromPersisted";
import type { SubAgentResult } from "./delegation";

/** Default cap for MainAgent → ToolAgent `rpcCollectChatTurn` await (`delegate_tool_task`). */
export const TOOL_AGENT_DELEGATION_TIMEOUT_MS_DEFAULT = 600_000;

export function resolveToolAgentDelegationTimeoutMs(variables: {
  TOOL_AGENT_DELEGATION_TIMEOUT_MS?: string;
} | null | undefined): number {
  const raw = variables?.TOOL_AGENT_DELEGATION_TIMEOUT_MS?.trim();
  if (!raw) return TOOL_AGENT_DELEGATION_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return TOOL_AGENT_DELEGATION_TIMEOUT_MS_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 10_000), 3_600_000);
}

/**
 * Ensures `delegate_tool_task` always settles even if ToolAgent RPC hangs after cancellation/recovery.
 */
export async function raceToolAgentDelegationRpc(
  promise: Promise<SubAgentResult>,
  timeoutMs: number
): Promise<SubAgentResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<SubAgentResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            text: "",
            events: [],
            ok: false,
            error: `tool_agent_delegation_timeout_after_${timeoutMs}_ms`,
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type DelegateToolTaskKind =
  | "mcp_api"
  | "external_api"
  | "tool_orchestration"
  | "unknown";

/** RPC-shaped result from {@link MainAgent.delegateToToolAgent} (and Throwable → ok:false). */
export interface DelegateToolTaskRpcShape {
  ok: boolean;
  error?: string;
  text: string;
}

export interface DelegateToolTaskTurnLatches {
  delegationTerminal: boolean;
  delegationFailed: boolean;
  delegateOk: boolean;
  bootstrapFailed: boolean;
  bootstrapError: string;
  resultEmpty: boolean;
}

export function sanitizeToolAgentBootstrapTelemetryError(raw: string, maxLen = 320): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

const DELEGATION_FAKE_TOOL_MARKUP_RES = [
  /<tool_call\b/i,
  /<\/tool_call>/i,
  /<arg_key\b/i,
  /<arg_value\b/i,
];

/** True when assistant text looks like pseudo XML tool-call markup (hallucinated tool protocol). */
export function delegateSuccessReplyContainsForbiddenToolMarkup(text: string): boolean {
  const t = typeof text === "string" ? text : "";
  return DELEGATION_FAKE_TOOL_MARKUP_RES.some((re) => re.test(t));
}

/** User explicitly requested literal tool-call markup examples in their prompt. */
export function userAskedForLiteralToolCallMarkup(userRequest: string | undefined): boolean {
  const u = typeof userRequest === "string" ? userRequest : "";
  const lower = u.toLowerCase();
  return (
    lower.includes("<tool_call") ||
    lower.includes("<arg_key") ||
    lower.includes("<arg_value")
  );
}

export function formatDelegateToolTaskFakeToolMarkupFailureReply(): string {
  return (
    `[delegate_tool_task] failed: ToolAgent output contained pseudo tool-call markup ` +
    `(\`<tool_call>\`, \`<arg_key>\`, \`<arg_value>\`) instead of a plain completion. ` +
    `That is not executable here — treat this as a failed delegation.\n\n` +
    `Retry with a narrower request or verify ToolAgent MCP/codemode health.`
  );
}

/** When true, a failed `delegate_tool_task` must not continue MCP/OpenAPI/codemode on the same turn. */
export function delegateToolTaskFailureShouldHardStopOrchestration(
  taskKind: DelegateToolTaskKind
): boolean {
  return (
    taskKind === "mcp_api" ||
    taskKind === "external_api" ||
    taskKind === "tool_orchestration" ||
    taskKind === "unknown"
  );
}

export function formatDelegateToolTaskMcpBootstrapFailureReply(errorDetail: string): string {
  const detail = errorDetail.trim() || "Unknown error";
  return (
    `[delegate_tool_task] failed: ToolAgent MCP bootstrap did not complete.\n\n` +
    `**What happened:** ToolAgent delegation failed while restoring MCP (before any ToolAgent LLM / AI Gateway request).\n\n` +
    `**Reason:** ${detail}\n\n` +
    `**Note:** No ToolAgent API call was made.\n\n` +
    `**Recommended:** Reconnect or re-save the MCP server in EdgeClaw Settings so OAuth fields and **callbackHost** persist, or verify **EDGECLAW_PUBLIC_ORIGIN** matches your Worker public HTTPS origin.`
  );
}

export function formatDelegateToolTaskGenericFailureReply(errorDetail: string): string {
  const detail = errorDetail.trim() || "Unknown error";
  return (
    `[delegate_tool_task] failed: ${detail}\n\n` +
    `No ToolAgent completion was returned for this delegation attempt.`
  );
}

export function isLikelyToolAgentMcpBootstrapFailureMessage(message: string): boolean {
  const m = message.trim();
  if (m.includes(TOOL_AGENT_MCP_RESTORE_FAILED_PREFIX)) return true;
  if (/MCP restore failed/i.test(m)) return true;
  // "missing authUrl" often indicates OAuth routing was wrongly applied when auth.required is false (restore fixes).
  if (m.includes("OAuth configuration incomplete") && !/missing authUrl/i.test(m)) return true;
  return false;
}

/**
 * Derives user-visible reply and turn latch fields from a ToolAgent delegation RPC outcome.
 */
export function computeDelegateToolTaskTurnLatchesAndReply(args: {
  taskKind: DelegateToolTaskKind;
  rpc: DelegateToolTaskRpcShape;
  /** Original user request — used to allow literal markup only when explicitly asked. */
  userRequest?: string;
}): { latches: DelegateToolTaskTurnLatches; reply: string } {
  const { taskKind, rpc } = args;
  const userRequest = args.userRequest;
  if (rpc.ok) {
    const trimmed = rpc.text.trim();
    if (
      trimmed.length > 0 &&
      !userAskedForLiteralToolCallMarkup(userRequest) &&
      delegateSuccessReplyContainsForbiddenToolMarkup(trimmed)
    ) {
      const stop = delegateToolTaskFailureShouldHardStopOrchestration(taskKind);
      return {
        latches: {
          delegationTerminal: stop,
          delegationFailed: stop,
          delegateOk: false,
          bootstrapFailed: false,
          bootstrapError: "",
          resultEmpty: false,
        },
        reply: formatDelegateToolTaskFakeToolMarkupFailureReply(),
      };
    }
    return {
      latches: {
        delegationTerminal: true,
        delegationFailed: false,
        delegateOk: true,
        bootstrapFailed: false,
        bootstrapError: "",
        resultEmpty: trimmed.length === 0,
      },
      reply: trimmed || "[delegate_tool_task] Done (empty reply).",
    };
  }

  const rawErr = (rpc.error ?? "").trim();
  const timeoutMsMatch = /^tool_agent_delegation_timeout_after_(\d+)_ms$/.exec(rawErr);
  if (timeoutMsMatch) {
    const ms = timeoutMsMatch[1]!;
    const stop = delegateToolTaskFailureShouldHardStopOrchestration(taskKind);
    return {
      latches: {
        delegationTerminal: stop,
        delegationFailed: stop,
        delegateOk: false,
        bootstrapFailed: false,
        bootstrapError: "",
        resultEmpty: false,
      },
      reply: formatDelegateToolTaskGenericFailureReply(
        `ToolAgent delegation timed out after ${ms}ms (MainAgent stopped waiting). ` +
          `The ToolAgent durable object may still finish in the background — retry with a narrower task if needed.`
      ),
    };
  }

  const tailText = rpc.text.trim();
  const combinedDetail =
    [rawErr, tailText].filter(Boolean).join(" — ").trim() || "Unknown error";
  const stop = delegateToolTaskFailureShouldHardStopOrchestration(taskKind);
  const bootstrapDetail = rawErr || combinedDetail;
  const bootstrap = isLikelyToolAgentMcpBootstrapFailureMessage(bootstrapDetail);

  return {
    latches: {
      delegationTerminal: stop,
      delegationFailed: stop,
      delegateOk: false,
      bootstrapFailed: bootstrap,
      bootstrapError: bootstrap ? sanitizeToolAgentBootstrapTelemetryError(bootstrapDetail) : "",
      resultEmpty: false,
    },
    reply: bootstrap
      ? formatDelegateToolTaskMcpBootstrapFailureReply(bootstrapDetail)
      : formatDelegateToolTaskGenericFailureReply(combinedDetail),
  };
}
