/**
 * Machine-readable prefix so delegated sub-agents know which shared project id + role apply.
 * Parent orchestrator prepends this; sub-agents parse from the user message (Think chat body).
 */

export interface ParsedDelegationEnvelope {
  projectId: string;
  role: "coder" | "tester";
  /** User/agent task text after the envelope. */
  body: string;
  /** Optional control-plane project id for AI Gateway metadata (when distinct from shared workspace id). */
  controlPlaneProjectId?: string;
  /** Control-plane task id when threaded by the orchestrator. */
  taskId?: string;
  /** Coding-loop or coordinator run id for AI Gateway metadata. */
  runId?: string;
}

/** Optional fields embedded in the shared-workspace delegation JSON envelope. */
export interface DelegationEnvelopeObservability {
  controlPlaneProjectId?: string;
  taskId?: string;
  runId?: string;
}

const START = "[EdgeClawSharedWorkspace]";
const END = "[/EdgeClawSharedWorkspace]";

/**
 * Parent-side: prepend before delegated task message.
 */
export function formatSharedDelegationEnvelope(
  projectId: string,
  role: "coder" | "tester",
  taskBody: string,
  obs?: DelegationEnvelopeObservability
): string {
  const json = JSON.stringify({
    projectId,
    role,
    ...(obs?.runId?.trim() ? { runId: obs.runId.trim() } : {}),
    ...(obs?.taskId?.trim() ? { taskId: obs.taskId.trim() } : {}),
    ...(obs?.controlPlaneProjectId?.trim()
      ? { controlPlaneProjectId: obs.controlPlaneProjectId.trim() }
      : {}),
  });
  return `${START}${json}${END}\n${taskBody}`;
}

/**
 * Sub-agent-side: strip envelope if present.
 */
export function parseSharedDelegationEnvelope(message: string): ParsedDelegationEnvelope | null {
  const idx = message.indexOf(START);
  if (idx !== 0) {
    return null;
  }
  const endIdx = message.indexOf(END);
  if (endIdx < 0) {
    return null;
  }
  const jsonRaw = message.slice(idx + START.length, endIdx).trim();
  let parsed: {
    projectId?: string;
    role?: string;
    runId?: string;
    taskId?: string;
    controlPlaneProjectId?: string;
  };
  try {
    parsed = JSON.parse(jsonRaw) as typeof parsed;
  } catch {
    return null;
  }
  const projectId = typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
  const role = parsed.role === "coder" || parsed.role === "tester" ? parsed.role : null;
  if (!projectId || !role) {
    return null;
  }
  const body = message.slice(endIdx + END.length).replace(/^\s*\n/, "");
  const runId = typeof parsed.runId === "string" && parsed.runId.trim() ? parsed.runId.trim() : undefined;
  const taskId = typeof parsed.taskId === "string" && parsed.taskId.trim() ? parsed.taskId.trim() : undefined;
  const controlPlaneProjectId =
    typeof parsed.controlPlaneProjectId === "string" && parsed.controlPlaneProjectId.trim()
      ? parsed.controlPlaneProjectId.trim()
      : undefined;
  return { projectId, role, body, runId, taskId, controlPlaneProjectId };
}
