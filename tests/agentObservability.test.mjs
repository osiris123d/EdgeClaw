/**
 * Mirrors `src/lib/agentObservability.ts` + `src/workspace/delegationEnvelope.ts` (keep in sync).
 * Avoids importing `dist/` from Node (extensionless ESM resolution).
 */

import test from "node:test";
import assert from "node:assert/strict";

const GATEWAY_META_KEYS = ["worker", "agent", "project", "task", "run"];

function pickScalar(v) {
  if (v == null) return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, 512);
}

function buildAiGatewayMetadataRecord(input) {
  const out = {};
  const worker = input.worker?.trim() || "EdgeClaw";
  out.worker = worker;
  const agent = String(input.agent).trim();
  if (agent) out.agent = agent;
  const project = pickScalar(input.projectId);
  if (project !== undefined) out.project = project;
  const task = pickScalar(input.taskId);
  if (task !== undefined) out.task = task;
  const run = pickScalar(input.runId);
  if (run !== undefined) out.run = run;
  const capped = {};
  for (const k of GATEWAY_META_KEYS) {
    if (out[k] !== undefined) capped[k] = out[k];
  }
  return capped;
}

const START = "[EdgeClawSharedWorkspace]";
const END = "[/EdgeClawSharedWorkspace]";

function parseSharedDelegationEnvelope(message) {
  const idx = message.indexOf(START);
  if (idx !== 0) return null;
  const endIdx = message.indexOf(END);
  if (endIdx < 0) return null;
  const jsonRaw = message.slice(idx + START.length, endIdx).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonRaw);
  } catch {
    return null;
  }
  const projectId = typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
  const role = parsed.role === "coder" || parsed.role === "tester" ? parsed.role : null;
  if (!projectId || !role) return null;
  const body = message.slice(endIdx + END.length).replace(/^\s*\n/, "");
  const runId = typeof parsed.runId === "string" && parsed.runId.trim() ? parsed.runId.trim() : undefined;
  const taskId = typeof parsed.taskId === "string" && parsed.taskId.trim() ? parsed.taskId.trim() : undefined;
  const controlPlaneProjectId =
    typeof parsed.controlPlaneProjectId === "string" && parsed.controlPlaneProjectId.trim()
      ? parsed.controlPlaneProjectId.trim()
      : undefined;
  return { projectId, role, body, runId, taskId, controlPlaneProjectId };
}

function gatewayObservabilityFromDelegatedUserMessage(rawMessage, fallbackAgent) {
  const trimmed = typeof rawMessage === "string" ? rawMessage.trim() : "";
  const parsed = parseSharedDelegationEnvelope(trimmed);
  if (!parsed) return { agent: fallbackAgent };
  const agent = parsed.role === "coder" ? "CoderAgent" : "TesterAgent";
  const projectId = (parsed.controlPlaneProjectId?.trim() || parsed.projectId).trim() || undefined;
  return {
    agent,
    ...(projectId ? { projectId } : {}),
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    ...(parsed.runId ? { runId: parsed.runId } : {}),
  };
}

test("buildAiGatewayMetadataRecord enforces five keys and defaults worker", () => {
  const r = buildAiGatewayMetadataRecord({
    agent: "CoderAgent",
    projectId: "proj-1",
    taskId: "task-9",
    runId: "run-42",
  });
  assert.equal(r.worker, "EdgeClaw");
  assert.equal(r.agent, "CoderAgent");
  assert.equal(r.project, "proj-1");
  assert.equal(r.task, "task-9");
  assert.equal(r.run, "run-42");
  assert.deepEqual(Object.keys(r).sort(), ["agent", "project", "run", "task", "worker"]);
});

test("gatewayObservabilityFromDelegatedUserMessage parses envelope", () => {
  const msg =
    "[EdgeClawSharedWorkspace]" +
    JSON.stringify({
      projectId: "shared-1",
      role: "tester",
      taskId: "t1",
      runId: "r2",
      controlPlaneProjectId: "cp-proj",
    }) +
    "[/EdgeClawSharedWorkspace]\nDo work";
  const o = gatewayObservabilityFromDelegatedUserMessage(msg, "CoderAgent");
  assert.equal(o.agent, "TesterAgent");
  assert.equal(o.projectId, "cp-proj");
  assert.equal(o.taskId, "t1");
  assert.equal(o.runId, "r2");
});
