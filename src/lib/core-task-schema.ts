/**
 * lib/core-task-schema.ts
 * Strongly typed core task schemas, examples, and runtime validators for Workers-safe execution.
 */

export const TASK_TYPES = [
  "incident_triage",
  "change_review",
  "report_draft",
  "exec_summary",
  "vendor_followup",
  "root_cause_analysis",
] as const;

export const DOMAIN_TYPES = [
  "wifi",
  "nac",
  "ztna",
  "telecom",
  "content_filtering",
  "cross_domain",
] as const;

export const TASK_STATUSES = [
  "queued",
  "in_progress",
  "blocked",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export const APPROVAL_STATES = [
  "not_required",
  "pending",
  "approved",
  "rejected",
  "escalated",
] as const;

export const AGENT_ROLES = [
  "dispatcher",
  "analyst",
  "drafter",
  "auditor",
  "orchestrator",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type DomainType = (typeof DOMAIN_TYPES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface ArtifactReference {
  artifactId: string;
  kind: "r2" | "url" | "inline";
  uri: string;
  contentType?: string;
  checksumSha256?: string;
  version?: string;
  createdAt: string;
}

export interface EscalationRule {
  level: "warn" | "critical";
  condition: string;
  action: "notify_owner" | "notify_oncall" | "pause_task" | "escalate_manager";
  timeoutMinutes?: number;
}

export interface TaskMetadata {
  tenantId?: string;
  correlationId?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  tags?: string[];
  source?: "api" | "workflow" | "manual";
  custom?: Record<string, unknown>;
}

export interface TaskPacket {
  taskId: string;
  taskType: TaskType;
  domain: DomainType;
  title: string;
  goal: string;
  definitionOfDone: string[];
  allowedTools: string[];
  forbiddenActions: string[];
  inputArtifacts: ArtifactReference[];
  dependencies: string[];
  status: TaskStatus;
  approvalState: ApprovalState;
  escalationRules: EscalationRule[];
  createdAt: string;
  updatedAt: string;
  assignedAgentRole: AgentRole;
  metadata: TaskMetadata;
}

export interface WorklogEntry {
  entryId: string;
  taskId: string;
  agentRole: AgentRole;
  timestamp: string;
  action: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface AuditResult {
  auditId: string;
  taskId: string;
  approved: boolean;
  approvalState: ApprovalState;
  score: number;
  findings: Array<{
    severity: "low" | "medium" | "high";
    code: string;
    message: string;
    recommendation?: string;
  }>;
  reviewerRole: AgentRole;
  reviewedAt: string;
}

export const EXAMPLE_ARTIFACT: ArtifactReference = {
  artifactId: "artifact-r2-001",
  kind: "r2",
  uri: "r2://task-inputs/inc-1001/context.json",
  contentType: "application/json",
  checksumSha256: "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
  version: "1",
  createdAt: "2026-03-31T12:00:00.000Z",
};

export const EXAMPLE_TASK_PACKET: TaskPacket = {
  taskId: "task-inc-1001",
  taskType: "incident_triage",
  domain: "wifi",
  title: "Triage AP authentication failures in HQ",
  goal: "Identify root symptom clusters and produce containment plan.",
  definitionOfDone: [
    "Top 3 probable causes identified",
    "Containment recommendation documented",
    "Escalation owner assigned if unresolved",
  ],
  allowedTools: ["r2.read", "worklog.append", "ai_gateway.analyze"],
  forbiddenActions: ["direct_device_config_change", "credential_exfiltration", "customer_pii_export"],
  inputArtifacts: [EXAMPLE_ARTIFACT],
  dependencies: [],
  status: "queued",
  approvalState: "pending",
  escalationRules: [
    {
      level: "warn",
      condition: "No progress update in 30 minutes",
      action: "notify_owner",
      timeoutMinutes: 30,
    },
    {
      level: "critical",
      condition: "SLA breach risk > 80%",
      action: "notify_oncall",
      timeoutMinutes: 10,
    },
  ],
  createdAt: "2026-03-31T12:00:00.000Z",
  updatedAt: "2026-03-31T12:00:00.000Z",
  assignedAgentRole: "analyst",
  metadata: {
    tenantId: "tenant-acme",
    correlationId: "corr-789",
    priority: "high",
    tags: ["wifi", "incident", "hq"],
    source: "api",
    custom: { region: "NA" },
  },
};

export const EXAMPLE_WORKLOG_ENTRY: WorklogEntry = {
  entryId: "log-001",
  taskId: "task-inc-1001",
  agentRole: "analyst",
  timestamp: "2026-03-31T12:02:00.000Z",
  action: "analysis_started",
  summary: "Parsed input artifacts and began anomaly clustering.",
  detail: { artifactCount: 1 },
};

export const EXAMPLE_AUDIT_RESULT: AuditResult = {
  auditId: "audit-001",
  taskId: "task-inc-1001",
  approved: true,
  approvalState: "approved",
  score: 92,
  findings: [
    {
      severity: "low",
      code: "EVIDENCE_DEPTH",
      message: "Could add one additional packet capture source for confidence.",
      recommendation: "Attach AP-side pcap in follow-up artifact.",
    },
  ],
  reviewerRole: "auditor",
  reviewedAt: "2026-03-31T12:08:00.000Z",
};

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

export function isDomainType(value: unknown): value is DomainType {
  return typeof value === "string" && (DOMAIN_TYPES as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isApprovalState(value: unknown): value is ApprovalState {
  return typeof value === "string" && (APPROVAL_STATES as readonly string[]).includes(value);
}

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

export function validateArtifactReference(input: unknown): ValidationResult<ArtifactReference> {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["ArtifactReference must be an object."] };
  }

  if (!isNonEmptyString(input.artifactId)) errors.push("artifactId is required.");
  if (!isNonEmptyString(input.uri)) errors.push("uri is required.");
  if (!isNonEmptyString(input.createdAt) || !isIsoDateString(input.createdAt)) {
    errors.push("createdAt must be an ISO date string.");
  }

  if (!(input.kind === "r2" || input.kind === "url" || input.kind === "inline")) {
    errors.push("kind must be one of: r2, url, inline.");
  }

  if (input.contentType !== undefined && typeof input.contentType !== "string") {
    errors.push("contentType must be a string when provided.");
  }

  if (input.checksumSha256 !== undefined && typeof input.checksumSha256 !== "string") {
    errors.push("checksumSha256 must be a string when provided.");
  }

  if (input.version !== undefined && typeof input.version !== "string") {
    errors.push("version must be a string when provided.");
  }

  return errors.length === 0
    ? { ok: true, errors: [], value: input as unknown as ArtifactReference }
    : { ok: false, errors };
}

export function validateTaskPacket(input: unknown): ValidationResult<TaskPacket> {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["TaskPacket must be an object."] };
  }

  if (!isNonEmptyString(input.taskId)) errors.push("taskId is required.");
  if (!isTaskType(input.taskType)) errors.push("taskType is invalid.");
  if (!isDomainType(input.domain)) errors.push("domain is invalid.");
  if (!isNonEmptyString(input.title)) errors.push("title is required.");
  if (!isNonEmptyString(input.goal)) errors.push("goal is required.");
  if (!isStringArray(input.definitionOfDone)) errors.push("definitionOfDone must be a string array.");
  if (!isStringArray(input.allowedTools)) errors.push("allowedTools must be a string array.");
  if (!isStringArray(input.forbiddenActions)) errors.push("forbiddenActions must be a string array.");
  if (!isStringArray(input.dependencies)) errors.push("dependencies must be a string array.");
  if (!isTaskStatus(input.status)) errors.push("status is invalid.");
  if (!isApprovalState(input.approvalState)) errors.push("approvalState is invalid.");
  if (!isAgentRole(input.assignedAgentRole)) errors.push("assignedAgentRole is invalid.");

  if (!isNonEmptyString(input.createdAt) || !isIsoDateString(input.createdAt)) {
    errors.push("createdAt must be an ISO date string.");
  }
  if (!isNonEmptyString(input.updatedAt) || !isIsoDateString(input.updatedAt)) {
    errors.push("updatedAt must be an ISO date string.");
  }

  if (!Array.isArray(input.inputArtifacts)) {
    errors.push("inputArtifacts must be an array.");
  } else {
    input.inputArtifacts.forEach((artifact: unknown, idx: number) => {
      const result = validateArtifactReference(artifact);
      if (!result.ok) {
        errors.push(...result.errors.map((e: string) => `inputArtifacts[${idx}]: ${e}`));
      }
    });
  }

  if (!Array.isArray(input.escalationRules)) {
    errors.push("escalationRules must be an array.");
  } else {
    input.escalationRules.forEach((rule: unknown, idx: number) => {
      if (!isRecord(rule)) {
        errors.push(`escalationRules[${idx}] must be an object.`);
        return;
      }

      const level = rule.level;
      const action = rule.action;

      if (!(level === "warn" || level === "critical")) {
        errors.push(`escalationRules[${idx}].level must be warn or critical.`);
      }
      if (!isNonEmptyString(rule.condition)) {
        errors.push(`escalationRules[${idx}].condition is required.`);
      }
      if (!(action === "notify_owner" || action === "notify_oncall" || action === "pause_task" || action === "escalate_manager")) {
        errors.push(`escalationRules[${idx}].action is invalid.`);
      }
      if (rule.timeoutMinutes !== undefined && typeof rule.timeoutMinutes !== "number") {
        errors.push(`escalationRules[${idx}].timeoutMinutes must be a number when provided.`);
      }
    });
  }

  if (!isRecord(input.metadata)) {
    errors.push("metadata must be an object.");
  }

  return errors.length === 0
    ? { ok: true, errors: [], value: input as unknown as TaskPacket }
    : { ok: false, errors };
}

export function validateWorklogEntry(input: unknown): ValidationResult<WorklogEntry> {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["WorklogEntry must be an object."] };
  }

  if (!isNonEmptyString(input.entryId)) errors.push("entryId is required.");
  if (!isNonEmptyString(input.taskId)) errors.push("taskId is required.");
  if (!isAgentRole(input.agentRole)) errors.push("agentRole is invalid.");
  if (!isNonEmptyString(input.action)) errors.push("action is required.");
  if (!isNonEmptyString(input.summary)) errors.push("summary is required.");
  if (!isNonEmptyString(input.timestamp) || !isIsoDateString(input.timestamp)) {
    errors.push("timestamp must be an ISO date string.");
  }

  if (input.detail !== undefined && !isRecord(input.detail)) {
    errors.push("detail must be an object when provided.");
  }

  return errors.length === 0
    ? { ok: true, errors: [], value: input as unknown as WorklogEntry }
    : { ok: false, errors };
}

export function validateAuditResult(input: unknown): ValidationResult<AuditResult> {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["AuditResult must be an object."] };
  }

  if (!isNonEmptyString(input.auditId)) errors.push("auditId is required.");
  if (!isNonEmptyString(input.taskId)) errors.push("taskId is required.");
  if (typeof input.approved !== "boolean") errors.push("approved must be a boolean.");
  if (!isApprovalState(input.approvalState)) errors.push("approvalState is invalid.");
  if (typeof input.score !== "number" || input.score < 0 || input.score > 100) {
    errors.push("score must be a number from 0 to 100.");
  }
  if (!isAgentRole(input.reviewerRole)) errors.push("reviewerRole is invalid.");
  if (!isNonEmptyString(input.reviewedAt) || !isIsoDateString(input.reviewedAt)) {
    errors.push("reviewedAt must be an ISO date string.");
  }

  if (!Array.isArray(input.findings)) {
    errors.push("findings must be an array.");
  } else {
    input.findings.forEach((finding: unknown, idx: number) => {
      if (!isRecord(finding)) {
        errors.push(`findings[${idx}] must be an object.`);
        return;
      }

      if (!(finding.severity === "low" || finding.severity === "medium" || finding.severity === "high")) {
        errors.push(`findings[${idx}].severity is invalid.`);
      }
      if (!isNonEmptyString(finding.code)) {
        errors.push(`findings[${idx}].code is required.`);
      }
      if (!isNonEmptyString(finding.message)) {
        errors.push(`findings[${idx}].message is required.`);
      }
      if (finding.recommendation !== undefined && typeof finding.recommendation !== "string") {
        errors.push(`findings[${idx}].recommendation must be a string when provided.`);
      }
    });
  }

  return errors.length === 0
    ? { ok: true, errors: [], value: input as unknown as AuditResult }
    : { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isIsoDateString(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}
