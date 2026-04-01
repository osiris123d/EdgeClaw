/**
 * lib/r2.ts
 * Opinionated R2 storage helpers using object-key prefixes (not real folders).
 *
 * Prefix model:
 * - R2 is a flat object store. "directories" are key naming conventions.
 * - list({ prefix }) returns objects whose key starts with that prefix.
 * - Example prefix: org/hilton/tasks/{taskId}/worklog/
 */

import { TaskPacket, WorklogEntry as CoreWorklogEntry } from "./core-task-schema";
import { R2BucketLike, R2ObjectLike, WorklogEntry as LegacyWorklogEntry } from "./types";

const DEFAULT_ORG_PREFIX = "org/hilton";

export interface R2KeyOptions {
  orgPrefix?: string;
}

export interface KnowledgeDoc {
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export function keyTask(taskId: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/tasks/${segment(taskId)}/task.json`;
}

export function keyWorklogEntry(taskId: string, entryId: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/tasks/${segment(taskId)}/worklog/${segment(entryId)}.json`;
}

export function keyWorklogPrefix(taskId: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/tasks/${segment(taskId)}/worklog/`;
}

export function keyTaskArtifact(taskId: string, name: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/tasks/${segment(taskId)}/artifacts/${segment(name)}`;
}

export function keyTaskArtifactsPrefix(taskId: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/tasks/${segment(taskId)}/artifacts/`;
}

export function keyIncidentSummary(incidentId: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/incidents/${segment(incidentId)}/summary.json`;
}

export function keyReportDraft(reportId: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/reports/${segment(reportId)}/draft.md`;
}

export function keyKnowledgeDoc(
  domain: string,
  category: string,
  fileName: string,
  options?: R2KeyOptions
): string {
  return `${basePrefix(options)}/knowledge/${segment(domain)}/${segment(category)}/${segment(fileName)}`;
}

export function keyUserProfile(userId: string, options?: R2KeyOptions): string {
  return `${basePrefix(options)}/users/${segment(userId)}/profile.json`;
}

export async function putTask(
  bucket: R2BucketLike,
  task: TaskPacket,
  options?: R2KeyOptions
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = keyTask(task.taskId, options);
  const body = safeJsonStringify(task);
  if (!body.ok) return body;

  return putObject(bucket, key, body.value, "application/json");
}

export async function getTask(
  bucket: R2BucketLike,
  taskId: string,
  options?: R2KeyOptions
): Promise<TaskPacket | null> {
  return getJsonObject<TaskPacket>(bucket, keyTask(taskId, options));
}

export async function appendWorklogEntry(
  bucket: R2BucketLike,
  entry: CoreWorklogEntry,
  options?: R2KeyOptions
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = keyWorklogEntry(entry.taskId, entry.entryId, options);
  const body = safeJsonStringify(entry);
  if (!body.ok) return body;

  return putObject(bucket, key, body.value, "application/json");
}

export async function listWorklogEntries(
  bucket: R2BucketLike,
  taskId: string,
  options?: R2KeyOptions
): Promise<CoreWorklogEntry[]> {
  const prefix = keyWorklogPrefix(taskId, options);
  const listed = await bucket.list({ prefix });
  const keys = listed.objects.map((obj: R2ObjectLike) => obj.key).sort();

  const entries: CoreWorklogEntry[] = [];
  for (const key of keys) {
    const item = await getJsonObject<CoreWorklogEntry>(bucket, key);
    if (item) entries.push(item);
  }

  return entries;
}

export async function putArtifact(
  bucket: R2BucketLike,
  taskId: string,
  name: string,
  content: string | ArrayBuffer | Uint8Array,
  contentType?: string,
  options?: R2KeyOptions
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = keyTaskArtifact(taskId, name, options);
  try {
    // R2 accepts strings/ArrayBuffers/TypedArrays as body payloads.
    const value = typeof content === "string" ? content : content;
    await bucket.put(key, value as unknown as string, {
      httpMetadata: { contentType: contentType || "application/octet-stream" },
    });
    return { ok: true, key };
  } catch (error: unknown) {
    return { ok: false, error: toErrorMessage(error, `Failed putArtifact for key ${key}`) };
  }
}

export async function getArtifact(
  bucket: R2BucketLike,
  taskId: string,
  name: string,
  options?: R2KeyOptions
): Promise<{ key: string; body: unknown } | null> {
  const key = keyTaskArtifact(taskId, name, options);
  const obj = await bucket.get(key);
  if (!obj) return null;

  try {
    return { key, body: await obj.json<unknown>() };
  } catch {
    return null;
  }
}

export async function listArtifacts(
  bucket: R2BucketLike,
  taskId: string,
  options?: R2KeyOptions
): Promise<string[]> {
  const prefix = keyTaskArtifactsPrefix(taskId, options);
  const listed = await bucket.list({ prefix });
  return listed.objects.map((obj: R2ObjectLike) => obj.key).sort();
}

export async function saveKnowledgeDoc(
  bucket: R2BucketLike,
  domain: string,
  category: string,
  fileName: string,
  doc: KnowledgeDoc,
  options?: R2KeyOptions
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = keyKnowledgeDoc(domain, category, fileName, options);
  const body = safeJsonStringify(doc);
  if (!body.ok) return body;

  return putObject(bucket, key, body.value, "application/json");
}

export async function loadKnowledgeDoc(
  bucket: R2BucketLike,
  domain: string,
  category: string,
  fileName: string,
  options?: R2KeyOptions
): Promise<KnowledgeDoc | null> {
  return getJsonObject<KnowledgeDoc>(bucket, keyKnowledgeDoc(domain, category, fileName, options));
}

/**
 * Optional convenience wrapper class for caller ergonomics.
 */
export class R2Repository {
  private readonly bucket: R2BucketLike;
  private readonly worklogBucket: R2BucketLike;
  private readonly options?: R2KeyOptions;

  constructor(bucket: R2BucketLike, worklogBucket?: R2BucketLike, options?: R2KeyOptions) {
    this.bucket = bucket;
    this.worklogBucket = worklogBucket ?? bucket;
    this.options = options;
  }

  async putTask(task: TaskPacket): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
    return putTask(this.bucket, task, this.options);
  }

  async getTask(taskId: string): Promise<TaskPacket | null> {
    return getTask(this.bucket, taskId, this.options);
  }

  async appendWorklogEntry(entry: CoreWorklogEntry): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
    return appendWorklogEntry(this.worklogBucket, entry, this.options);
  }

  async listWorklogEntries(taskId: string): Promise<CoreWorklogEntry[]> {
    return listWorklogEntries(this.worklogBucket, taskId, this.options);
  }

  async putArtifact(
    taskId: string,
    nameOrContent: string | Record<string, unknown> | ArrayBuffer | Uint8Array,
    contentOrType?: string | ArrayBuffer | Uint8Array,
    contentType?: string
  ): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
    // Supports:
    // - putArtifact(taskId, "name.ext", content, contentType?)
    // - putArtifact(taskId, jsonObject)  // legacy fallback stored as output.json
    if (typeof nameOrContent === "string") {
      const name = nameOrContent;
      const content = (contentOrType as string | ArrayBuffer | Uint8Array | undefined) ?? "";
      return putArtifact(this.bucket, taskId, name, content, contentType, this.options);
    }

    if (nameOrContent instanceof ArrayBuffer || nameOrContent instanceof Uint8Array) {
      return putArtifact(this.bucket, taskId, "artifact.bin", nameOrContent, contentType, this.options);
    }

    const serialized = safeJsonStringify(nameOrContent);
    if (!serialized.ok) return serialized;
    return putArtifact(this.bucket, taskId, "output.json", serialized.value, "application/json", this.options);
  }

  async getArtifact(taskId: string, name: string): Promise<{ key: string; body: unknown } | null> {
    return getArtifact(this.bucket, taskId, name, this.options);
  }

  async listArtifacts(taskId: string): Promise<string[]> {
    return listArtifacts(this.bucket, taskId, this.options);
  }

  async saveKnowledgeDoc(
    domain: string,
    category: string,
    fileName: string,
    doc: KnowledgeDoc
  ): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
    return saveKnowledgeDoc(this.bucket, domain, category, fileName, doc, this.options);
  }

  async loadKnowledgeDoc(domain: string, category: string, fileName: string): Promise<KnowledgeDoc | null> {
    return loadKnowledgeDoc(this.bucket, domain, category, fileName, this.options);
  }

  // Backward-compatible aliases used by earlier prototype code.
  async appendWorklog(entry: LegacyWorklogEntry | CoreWorklogEntry): Promise<string> {
    const mapped = toCoreWorklogEntry(entry);
    const res = await this.appendWorklogEntry(mapped);
    if (!res.ok) throw new Error(res.error);
    return res.key;
  }

  async listWorklogs(taskId: string): Promise<string[]> {
    const entries = await this.listWorklogEntries(taskId);
    return entries.map((entry: CoreWorklogEntry) => keyWorklogEntry(taskId, entry.entryId, this.options));
  }
}

/**
 * Worker usage examples:
 *
 * export default {
 *   async fetch(request: Request, env: { R2_DATA: R2Bucket }) {
 *     const repo = new R2Repository(env.R2_DATA, undefined, { orgPrefix: "org/hilton" });
 *
 *     // Put/get task
 *     await repo.putTask(EXAMPLE_TASK_PACKET);
 *     const task = await repo.getTask(EXAMPLE_TASK_PACKET.taskId);
 *
 *     // Worklog append/list
 *     await repo.appendWorklogEntry(EXAMPLE_WORKLOG_ENTRY);
 *     const worklog = await repo.listWorklogEntries(EXAMPLE_WORKLOG_ENTRY.taskId);
 *
 *     // Artifact put/get/list
 *     await repo.putArtifact("task-inc-1001", "analysis.json", JSON.stringify({ ok: true }), "application/json");
 *     const artifact = await repo.getArtifact("task-inc-1001", "analysis.json");
 *     const artifactKeys = await repo.listArtifacts("task-inc-1001");
 *
 *     // Knowledge docs
 *     await repo.saveKnowledgeDoc("wifi", "playbooks", "triage-v1.json", {
 *       title: "WiFi triage v1",
 *       body: "Steps...",
 *       updatedAt: new Date().toISOString(),
 *     });
 *     const doc = await repo.loadKnowledgeDoc("wifi", "playbooks", "triage-v1.json");
 *
 *     return new Response(JSON.stringify({ task, worklogCount: worklog.length, artifact, artifactKeys, doc }));
 *   },
 * };
 */

function basePrefix(options?: R2KeyOptions): string {
  const prefix = options?.orgPrefix || DEFAULT_ORG_PREFIX;
  return prefix.replace(/\/$/, "");
}

function segment(value: string): string {
  // Keep key-safe segments and prevent accidental extra prefix nesting.
  return value.trim().replace(/^\/+|\/+$/g, "").replace(/\s+/g, "_");
}

async function getJsonObject<T>(bucket: R2BucketLike, key: string): Promise<T | null> {
  try {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return await obj.json<T>();
  } catch {
    return null;
  }
}

function safeJsonStringify(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.stringify(value) };
  } catch (error: unknown) {
    return { ok: false, error: toErrorMessage(error, "Failed to serialize JSON payload") };
  }
}

async function putObject(
  bucket: R2BucketLike,
  key: string,
  body: string,
  contentType: string
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  try {
    await bucket.put(key, body, {
      httpMetadata: { contentType },
    });
    return { ok: true, key };
  } catch (error: unknown) {
    return { ok: false, error: toErrorMessage(error, `Failed put for key ${key}`) };
  }
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function toCoreWorklogEntry(entry: LegacyWorklogEntry | CoreWorklogEntry): CoreWorklogEntry {
  if ("entryId" in entry) {
    return entry;
  }

  return {
    entryId: entry.id,
    taskId: entry.taskId,
    agentRole: mapAgentRole(entry.agent),
    timestamp: entry.timestamp,
    action: entry.step,
    summary: JSON.stringify(entry.details),
    detail: entry.details,
  };
}

function mapAgentRole(agent: LegacyWorklogEntry["agent"]): CoreWorklogEntry["agentRole"] {
  if (agent === "drafting") return "drafter";
  if (agent === "audit") return "auditor";
  return agent;
}
