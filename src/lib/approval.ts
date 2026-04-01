/**
 * lib/approval.ts
 *
 * Human-in-the-loop approval model for the OpenClaw-style planning system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * APPROVAL LIFECYCLE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. TRIGGER
 *    TaskWorkflow pauses after AuditAgent returns verdict ≠ "accept", or when
 *    the task matches a sensitivity heuristic: policy change, vendor draft,
 *    executive summary with low confidence, or high production risk.
 *
 * 2. RECORD
 *    An ApprovalRecord is written to R2 at:
 *      org/hilton/tasks/{taskId}/approval.json
 *    This is the single source of truth for the decision lifecycle.
 *    TaskCoordinatorDO tracks coordinator-level approvalState separately;
 *    the index.ts route handlers keep both in sync.
 *
 * 3. NOTIFICATION (caller's responsibility — NOT the agent's responsibility)
 *    After writing the ApprovalRecord, the API handler returns an
 *    ApprovalPendingInfo shape to the original requester. The caller may then:
 *      - Poll:    GET /tasks/:taskId/approval  (web UI, status page)
 *      - Push:    POST ApprovalPendingInfo.chatCard to a webhook
 *      - Email:   Send ApprovalPendingInfo.emailHtml via Email Workers
 *    DraftingAgent, AnalystAgent, and AuditAgent must NEVER send notifications
 *    directly — that constraint is enforced by each agent's hard-constraint list.
 *    TODO: Add CHAT_WEBHOOK_URL and REVIEWER_EMAIL_ADDRESS to Env when wiring.
 *
 * 4. DECISION
 *    Human reviewer calls:
 *      POST /tasks/:taskId/approve   { reviewerId, reason? }
 *      POST /tasks/:taskId/reject    { reviewerId, reason? }
 *    The endpoint:
 *      a. Validates the ApprovalRecord is still "pending" (idempotency guard).
 *      b. Acquires a coordinator lease.
 *      c. Re-invokes TaskWorkflow.run({ resumeAfterApproval: true, approvedByHuman }).
 *      d. Updates and persists the final ApprovalRecord.
 *      e. Returns ApprovalDecisionResponse.
 *
 * 5. FINALIZE
 *    Workflow loads all cached intermediate outputs from R2, skips completed
 *    steps, and runs only the finalize step.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRING INTO A WEB UI OR CHAT PLATFORM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Web UI (poll-based):
 *   - Call GET /tasks/:taskId/approval on page load and every 10–30 seconds.
 *   - When approval.state = "pending", render an Approve / Reject button pair
 *     alongside the audit findings table from ApprovalRecord.auditFindings.
 *   - On button click: POST /tasks/:taskId/approve or /reject with the
 *     authenticated user's ID as reviewerId.
 *   - On success: reload the task detail view.
 *   - Disable the Approve button if any finding.severity = "high" and
 *     provide visual confirmation prompts (e.g., "There are high-severity
 *     findings — are you sure?").
 *
 * Chat platform (Teams / Slack — webhook + action):
 *   - When the task pauses, POST the chatCard.pendingCard payload from
 *     ApprovalPendingInfo to CHAT_WEBHOOK_URL (from Env).
 *   - The card has two buttons whose Action URLs point to:
 *       POST /tasks/:taskId/approve
 *       POST /tasks/:taskId/reject
 *   - The chat platform sends the action POST with the user's identity;
 *     validate the platform's signature header before processing.
 *   - Reply to the action with the chatCard.confirmationCard from
 *     ApprovalDecisionResponse.
 *   TODO: Add CHAT_WEBHOOK_URL, CHAT_SIGNING_SECRET to Env and Wrangler vars.
 *
 * Email (magic-link):
 *   - Include ApprovalPendingInfo.emailHtml in an Email Workers send to
 *     REVIEWER_EMAIL_ADDRESS (from Env).
 *   - The email contains a signed JWT link to /tasks/:taskId/approve?token=<jwt>.
 *   - The Worker validates the JWT, extracts reviewerId, and calls the approval
 *     handler. Tokens must be short-lived (< 24h) and single-use.
 *   - Store used tokens in a KV namespace (TODO: Add APPROVAL_TOKENS_KV to Env)
 *     to prevent replay attacks.
 *   SECURITY NOTE: never log or store raw tokens. Invalidate on use.
 *   TODO: Add REVIEWER_EMAIL_ADDRESS, JWT_SECRET, APPROVAL_TOKENS_KV to Env.
 *
 * All notification channels are fire-and-forget. Notification failures must
 * not block or fail the approval flow — the record in R2 is authoritative.
 */

import { AuditFinding } from "../agents/AuditAgent";
import { R2BucketLike } from "./types";

const DEFAULT_ORG_PREFIX = "org/hilton";

// ─── Approval trigger ─────────────────────────────────────────────────────────

/**
 * ApprovalTrigger describes WHY the task was paused.
 * Drives reviewer notification text, UI priority badge, and escalation path.
 *
 * Priority order (highest → lowest): pii_detected > forbidden_action_ref >
 * audit_escalate_human > policy_change > production_risk > vendor_draft >
 * exec_summary_low_confidence > audit_revise
 */
export type ApprovalTrigger =
  | "audit_revise"                // AuditAgent verdict = "revise"
  | "audit_escalate_human"        // AuditAgent verdict = "escalate_human"
  | "pii_detected"                // AuditAgent finding code = PII_RISK
  | "forbidden_action_ref"        // AuditAgent finding code = FORBIDDEN_ACTION_REF
  | "policy_change"               // domain nac/ztna + taskType change_review
  | "vendor_draft"                // draftType = vendor_followup
  | "exec_summary_low_confidence" // exec_summary with analysis confidence < 0.65
  | "production_risk";            // riskAnalysis.level = "high"

export const APPROVAL_TRIGGER_LABELS: Record<ApprovalTrigger, string> = {
  audit_revise:                "Audit recommended revision",
  audit_escalate_human:        "Mandatory human escalation required",
  pii_detected:                "Potential PII detected — review before proceeding",
  forbidden_action_ref:        "Forbidden action referenced in output",
  policy_change:               "Network policy change — CAB review required",
  vendor_draft:                "Vendor communication draft — internal review required",
  exec_summary_low_confidence: "Executive summary with low-confidence analysis",
  production_risk:             "High production risk — engineering approval required",
};

// ─── Approval state model ─────────────────────────────────────────────────────

/**
 * ApprovalRecord is persisted to R2 as the authoritative approval lifecycle record.
 *
 * Persisted at: org/hilton/tasks/{taskId}/approval.json
 *
 * State transitions:
 *   (created) → pending → approved → (workflow finalizes)
 *                       → rejected → (task marked failed)
 *   (idempotency edge case): approved/rejected → superseded (new record created)
 *
 * IDEMPOTENCY: Once state is "approved" or "rejected", the decision endpoint
 * returns 409 Conflict rather than re-triggering the workflow. Callers must
 * create a new task to retry from scratch after a rejection.
 */
export interface ApprovalRecord {
  /** Unique ID for this approval request. */
  approvalId: string;
  taskId: string;
  /** Why this task was paused — drives notification copy and UI priority. */
  trigger: ApprovalTrigger;
  /** Human-readable one-paragraph summary shown to the reviewer. */
  summary: string;
  /** Audit verdict at pause time. */
  auditVerdict: "revise" | "escalate_human";
  /** Audit score 0–100 at pause time. */
  auditScore: number;
  /** Key audit findings copied here so reviewers can act without re-querying. */
  auditFindings: AuditFinding[];
  /**
   * Approval lifecycle.
   *   pending    — awaiting human decision
   *   approved   — workflow finalised
   *   rejected   — task stopped; create a new task to retry
   *   superseded — a second ApprovalRecord replaced this one (rare)
   */
  state: "pending" | "approved" | "rejected" | "superseded";
  /** When the workflow paused and this record was first written. */
  requestedAt: string;
  /** When the reviewer made their decision. */
  decidedAt?: string;
  /** Identity of the reviewer; set when state transitions from pending. */
  reviewerId?: string;
  /** Optional rationale from the reviewer. */
  reviewerNote?: string;
}

// ─── HTTP request / response shapes ──────────────────────────────────────────

/** Body for POST /tasks/:taskId/approve and POST /tasks/:taskId/reject. */
export interface ApprovalDecisionRequest {
  reviewerId: string;
  /** Optional free-text rationale stored in the ApprovalRecord. */
  reason?: string;
}

/**
 * Response for POST /tasks/:taskId/approve and POST /tasks/:taskId/reject.
 *
 * WEB UI:
 *   - Use `workflowStatus` to determine next page: "completed" → success view;
 *     "rejected" → failure view; "failed" → error page with error field.
 *   - Show approvalRecord.reviewerNote in the audit trail panel.
 *
 * CHAT:
 *   - POST chatCard.confirmationCard to the original approval request thread.
 *
 * EMAIL:
 *   - Send emailHtml as a receipt to reviewerId if REVIEWER_EMAIL_ADDRESS is set.
 */
export interface ApprovalDecisionResponse {
  ok: boolean;
  taskId: string;
  decision: "approved" | "rejected";
  workflowStatus: "completed" | "rejected" | "failed";
  approvalRecord: ApprovalRecord;
  /**
   * Placeholder Adaptive Card / Block Kit confirmation payload.
   * Replace `type` with your platform's card schema root element.
   * TODO: POST this to CHAT_WEBHOOK_URL (from Env) when wiring chat platform.
   */
  chatCard: {
    type: "approval_confirmation";
    taskId: string;
    decision: "approved" | "rejected";
    reviewerId: string;
    summary: string;
    workflowStatus: string;
  };
  /**
   * Placeholder HTML receipt for email confirmation.
   * TODO: Send via Cloudflare Email Workers or MailChannels when wiring email.
   */
  emailHtml: string;
  error?: string;
}

/**
 * Response for GET /tasks/:taskId/approval.
 *
 * WEB UI:
 *   - If approval === null: task is not paused; render normal task view.
 *   - If approval.state = "pending": render approval panel with Approve/Reject.
 *   - If approval.state = "approved" | "rejected": read-only decision summary.
 *
 * CHAT:
 *   - chatCard.pendingCard is the initial approval prompt card to post to the
 *     reviewer's channel. POST to CHAT_WEBHOOK_URL when state first becomes pending.
 *   TODO: populate with your platform's Adaptive Card / Block Kit schema fields.
 */
export interface ApprovalStatusResponse {
  ok: boolean;
  taskId: string;
  approval: ApprovalRecord | null;
  /**
   * Placeholder card payload for the initial approval request.
   * Sent to the chat platform ONCE when the task first pauses.
   * TODO: wire to CHAT_WEBHOOK_URL in Env.
   */
  chatCard: {
    type: "approval_request";
    taskId: string;
    trigger: ApprovalTrigger | null;
    triggerLabel: string;
    auditVerdict: string;
    auditScore: number;
    summaryText: string;
    /** Direct URL for the Approve action. Wire to your platform's button URL field. */
    approveUrl: string;
    /** Direct URL for the Reject action. Wire to your platform's button URL field. */
    rejectUrl: string;
    /** Rendered finding rows for display inside the card. */
    findingRows: Array<{ severity: string; code: string; message: string }>;
  };
}

/**
 * Returned by POST /tasks/run-next when the workflow pauses for approval.
 * Distinct from ApprovalDecisionResponse — this is the initial pause notification.
 */
export interface ApprovalPendingInfo {
  ok: true;
  taskId: string;
  status: "paused_for_approval";
  approval: ApprovalRecord;
  /**
   * Placeholder email HTML for the initial reviewer notification.
   * TODO: Send via Cloudflare Email Workers when REVIEWER_EMAIL_ADDRESS is set.
   */
  emailHtml: string;
  /**
   * Placeholder chat card for the initial approval prompt post.
   * TODO: POST to CHAT_WEBHOOK_URL when wiring the notification channel.
   */
  chatCard: {
    type: "approval_request";
    taskId: string;
    triggerLabel: string;
    auditScore: number;
    approveUrl: string;
    rejectUrl: string;
  };
}

// ─── R2 helpers ───────────────────────────────────────────────────────────────

export function keyApprovalRecord(taskId: string, orgPrefix = DEFAULT_ORG_PREFIX): string {
  const prefix = orgPrefix.replace(/\/$/, "");
  const safe = taskId.trim().replace(/^\/+|\/+$/g, "").replace(/\s+/g, "_");
  return `${prefix}/tasks/${safe}/approval.json`;
}

export async function putApprovalRecord(
  bucket: R2BucketLike,
  record: ApprovalRecord,
  orgPrefix?: string
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = keyApprovalRecord(record.taskId, orgPrefix);
  try {
    await bucket.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });
    return { ok: true, key };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error
        ? err.message
        : `Failed to write approval record for ${record.taskId}`,
    };
  }
}

export async function getApprovalRecord(
  bucket: R2BucketLike,
  taskId: string,
  orgPrefix?: string
): Promise<ApprovalRecord | null> {
  const key = keyApprovalRecord(taskId, orgPrefix);
  try {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return await obj.json<ApprovalRecord>();
  } catch {
    return null;
  }
}

// ─── Trigger classification ───────────────────────────────────────────────────

/**
 * classifyApprovalTrigger
 *
 * Determines the most specific trigger label given audit context.
 * Called by index.ts when a workflow result has status = "paused_for_approval".
 * Priority: PII > forbidden action > escalate_human > policy change > production
 * risk > vendor draft > exec_summary low-conf > generic revise.
 */
export function classifyApprovalTrigger(
  auditVerdict: "revise" | "escalate_human",
  auditFindings: AuditFinding[],
  taskDomain: string,
  taskType: string,
  draftType: string | undefined,
  analysisConfidence: number | undefined
): ApprovalTrigger {
  const codes = new Set(auditFindings.map((f) => f.code));
  if (codes.has("PII_RISK")) return "pii_detected";
  if (codes.has("FORBIDDEN_ACTION_REF")) return "forbidden_action_ref";
  if (auditVerdict === "escalate_human") return "audit_escalate_human";
  if ((taskDomain === "nac" || taskDomain === "ztna") && taskType === "change_review") {
    return "policy_change";
  }
  if (draftType === "vendor_followup") return "vendor_draft";
  if (taskType === "exec_summary" && (analysisConfidence ?? 1) < 0.65) {
    return "exec_summary_low_confidence";
  }
  return "audit_revise";
}

export function buildApprovalSummary(
  record: Pick<ApprovalRecord, "trigger" | "auditVerdict" | "auditScore" | "auditFindings">
): string {
  const label = APPROVAL_TRIGGER_LABELS[record.trigger];
  const highFindings = record.auditFindings.filter((f) => f.severity === "high");
  const highStr = highFindings.length > 0
    ? ` High-severity findings: ${highFindings.map((f) => f.message).join("; ")}.`
    : "";
  return (
    `${label}. Audit score: ${record.auditScore}/100. Verdict: ${record.auditVerdict}.` +
    `${highStr} Human decision required before this output can proceed.`
  );
}

// ─── Response builders ────────────────────────────────────────────────────────

export function buildApprovalDecisionResponse(
  record: ApprovalRecord,
  decision: "approved" | "rejected",
  workflowStatus: "completed" | "rejected" | "failed",
  baseUrl: string,
  error?: string
): ApprovalDecisionResponse {
  const decisionWord = decision === "approved" ? "Approved" : "Rejected";
  return {
    ok: !error,
    taskId: record.taskId,
    decision,
    workflowStatus,
    approvalRecord: record,
    chatCard: {
      type: "approval_confirmation",
      taskId: record.taskId,
      decision,
      reviewerId: record.reviewerId ?? "unknown",
      summary: `Task ${record.taskId} ${decisionWord.toLowerCase()} by ${record.reviewerId ?? "reviewer"}. Workflow status: ${workflowStatus}.`,
      workflowStatus,
    },
    emailHtml: [
      `<h2>Approval ${decisionWord}</h2>`,
      `<p><strong>Task:</strong> ${record.taskId}</p>`,
      `<p><strong>Decision:</strong> ${decisionWord}</p>`,
      `<p><strong>Reviewer:</strong> ${record.reviewerId ?? "unknown"}</p>`,
      record.reviewerNote ? `<p><strong>Note:</strong> ${escHtml(record.reviewerNote)}</p>` : "",
      `<p><strong>Workflow status:</strong> ${workflowStatus}</p>`,
      `<p><em>View task: <a href="${baseUrl}/tasks/${record.taskId}">${baseUrl}/tasks/${record.taskId}</a></em></p>`,
    ].join(""),
    error,
  };
}

export function buildApprovalStatusResponse(
  taskId: string,
  approval: ApprovalRecord | null,
  baseUrl: string
): ApprovalStatusResponse {
  const trigger = approval?.trigger ?? null;
  return {
    ok: true,
    taskId,
    approval,
    chatCard: {
      type: "approval_request",
      taskId,
      trigger,
      triggerLabel: trigger ? APPROVAL_TRIGGER_LABELS[trigger] : "Pending review",
      auditVerdict: approval?.auditVerdict ?? "unknown",
      auditScore: approval?.auditScore ?? 0,
      summaryText: approval?.summary ?? "No approval record found.",
      approveUrl: `${baseUrl}/tasks/${taskId}/approve`,
      rejectUrl:  `${baseUrl}/tasks/${taskId}/reject`,
      findingRows: (approval?.auditFindings ?? []).map((f) => ({
        severity: f.severity,
        code: f.code,
        message: f.message,
      })),
    },
  };
}

export function buildApprovalPendingInfo(
  record: ApprovalRecord,
  baseUrl: string
): ApprovalPendingInfo {
  return {
    ok: true,
    taskId: record.taskId,
    status: "paused_for_approval",
    approval: record,
    emailHtml: [
      `<h2>Action Required: Task Approval</h2>`,
      `<p><strong>Task:</strong> ${record.taskId}</p>`,
      `<p><strong>Reason:</strong> ${escHtml(APPROVAL_TRIGGER_LABELS[record.trigger])}</p>`,
      `<p><strong>Audit score:</strong> ${record.auditScore}/100</p>`,
      `<p>${escHtml(record.summary)}</p>`,
      `<p>`,
      `  <a href="${baseUrl}/tasks/${record.taskId}/approve" style="margin-right:16px">✅ Approve</a>`,
      `  <a href="${baseUrl}/tasks/${record.taskId}/reject">❌ Reject</a>`,
      `</p>`,
      `<p><small>This approval request expires after 72 hours. After that, the task must be re-submitted.</small></p>`,
    ].join(""),
    chatCard: {
      type: "approval_request",
      taskId: record.taskId,
      triggerLabel: APPROVAL_TRIGGER_LABELS[record.trigger],
      auditScore: record.auditScore,
      approveUrl: `${baseUrl}/tasks/${record.taskId}/approve`,
      rejectUrl:  `${baseUrl}/tasks/${record.taskId}/reject`,
    },
  };
}

// ─── Example record ───────────────────────────────────────────────────────────

/**
 * EXAMPLE_APPROVAL_RECORD
 *
 * Example of what is persisted to R2 at:
 *   org/hilton/tasks/task-20260331-wifi-nac-001/approval.json
 *
 * This record is created at state = "pending" when the task pauses, then
 * updated in-place when the reviewer makes their decision (state → "approved").
 *
 * The record is written atomically to R2; intermediate states are never partial.
 * The coordinator DO approval state is updated in parallel by the decision route.
 */
export const EXAMPLE_APPROVAL_RECORD: ApprovalRecord = {
  approvalId: "approval-20260331-001",
  taskId: "task-20260331-wifi-nac-001",
  trigger: "policy_change",
  summary:
    "Network policy change. Audit score: 58/100. Verdict: revise. " +
    "High-severity findings: Draft claims 'root cause confirmed' without sufficient evidence; " +
    "proposed action lacks rollback plan and approval gate. " +
    "Human decision required before this output can proceed.",
  auditVerdict: "revise",
  auditScore: 58,
  auditFindings: [
    {
      severity: "high",
      code: "OVERCONFIDENCE",
      message:
        "Draft claims 'root cause confirmed' but only one artifact was provided (confidence 0.55).",
      recommendation:
        "Replace 'root cause confirmed' with 'root cause hypothesis' and add uncertainty flags.",
    },
    {
      severity: "high",
      code: "RISKY_RECOMMENDATION",
      message:
        "Proposed action 'disable NAC enforcement cluster-wide' lacks a rollback plan or approval gate.",
      recommendation:
        "Add rollback procedure and [APPROVAL GATE] marker; scope to a single VLAN first.",
    },
    {
      severity: "medium",
      code: "DEFINITION_OF_DONE_GAP",
      message: "Escalation owner not named in draft.",
      recommendation: "Add escalation contact or ticket reference.",
    },
  ],
  state: "approved",
  requestedAt: "2026-03-31T10:20:00.000Z",
  decidedAt: "2026-03-31T10:35:00.000Z",
  reviewerId: "mgr-john.doe@example.com",
  reviewerNote:
    "Reviewed and accepted with minor caveats. Root cause phrasing updated offline before distribution.",
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
