/**
 * lib/types.ts
 * Shared, explicit interfaces for the OpenClaw-style planning/task/audit prototype.
 */

export type TaskKind = "analyze" | "draft" | "audit";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "rejected";

export type AgentName = "dispatcher" | "analyst" | "drafting" | "audit";

export interface TaskInput {
  objective: string;
  payload: Record<string, unknown>;
  hints?: string[];
}

export interface TaskRequest {
  userId: string;
  kind?: TaskKind;
  input: TaskInput;
  metadata?: Record<string, string>;
}

export interface TaskRecord {
  id: string;
  userId: string;
  kind?: TaskKind;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  input: TaskInput;
  output?: Record<string, unknown>;
  audit?: AuditSummary;
  error?: string;
}

export interface AgentContext {
  taskId: string;
  userId: string;
  nowIso: string;
  metadata: Record<string, string>;
}

export interface AgentResult<TOutput> {
  agent: AgentName;
  ok: boolean;
  output: TOutput;
  warnings: string[];
  error?: string;
}

export interface DispatchDecision {
  kind: TaskKind;
  confidence: number;
  reason: string;
}

export interface AnalysisOutput {
  findings: string[];
  recommendations: string[];
  riskNotes: string[];
  rawModelText?: string;
}

export interface DraftOutput {
  title: string;
  summary: string;
  sections: Array<{ heading: string; body: string }>;
}

export interface AuditIssue {
  severity: "low" | "medium" | "high";
  code: "MISSING_CONTENT" | "PII_RISK" | "LOW_CONFIDENCE" | "UNKNOWN";
  message: string;
}

export interface AuditSummary {
  approved: boolean;
  score: number;
  issues: AuditIssue[];
}

export interface WorklogEntry {
  id: string;
  taskId: string;
  agent: AgentName;
  step: string;
  timestamp: string;
  details: Record<string, unknown>;
}

export interface TaskEnvelope {
  record: TaskRecord;
  worklog: WorklogEntry[];
}

export interface QueueMessage {
  taskId: string;
  enqueuedAt: string;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface R2ObjectLike {
  key: string;
}

export interface R2GetObjectLike {
  json<T>(): Promise<T>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<void>;
  get(key: string): Promise<R2GetObjectLike | null>;
  list(options?: { prefix?: string }): Promise<{ objects: R2ObjectLike[] }>;
}

export interface Env {
  TASK_COORDINATOR: DurableObjectNamespaceLike;
  R2_WORKLOGS: R2BucketLike;
  R2_ARTIFACTS: R2BucketLike;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_ROUTE_ANALYST?: string;
  AI_GATEWAY_ROUTE_CLASSIFIER?: string;
  AUTO_START_WORKFLOW?: string;
  WORKFLOW_START_ENDPOINT?: string;
}
