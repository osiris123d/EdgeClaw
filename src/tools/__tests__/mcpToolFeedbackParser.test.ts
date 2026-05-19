import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMcpToolFeedback,
  resolveMcpToolRetryInput,
  getToolEntryDescription,
  getToolEntrySchema,
} from "../mcpToolFeedback";

test("parseMcpToolFeedback parses missing parameter from error", () => {
  const out = parseMcpToolFeedback({
    errorMessage: "Please specify the project_id parameter.",
  });
  assert.ok(out);
  assert.equal(out.parameter, "project_id");
  assert.equal(out.source, "tool_error");
});

test("parseMcpToolFeedback extracts candidates from error", () => {
  const out = parseMcpToolFeedback({
    errorMessage: "Please specify the env parameter. Available environments: staging, production",
  });
  assert.ok(out);
  assert.deepEqual(out.candidates, ["staging", "production"]);
});

test("parseMcpToolFeedback merges schema enum candidates", () => {
  const out = parseMcpToolFeedback({
    errorMessage: "Please specify the region parameter.",
    schema: {
      type: "object",
      properties: { region: { type: "string", enum: ["us", "eu"] } },
      required: ["region"],
    },
  });
  assert.ok(out);
  assert.deepEqual(out.candidates, ["us", "eu"]);
});

test("parseMcpToolFeedback prefers richer error hit over bare description hit", () => {
  const out = parseMcpToolFeedback({
    description: "Pass project_id as the project_id parameter.",
    errorMessage: "Please specify the project_id parameter. Available projects: only-project",
  });
  assert.ok(out);
  assert.equal(out.source, "tool_error");
  assert.deepEqual(out.candidates, ["only-project"]);
});

test("parseMcpToolFeedback falls back to schema when prose missing", () => {
  const out = parseMcpToolFeedback({
    schema: {
      type: "object",
      properties: { region: { type: "string", enum: ["us-east", "eu-west"] } },
      required: ["region"],
    },
  });
  assert.ok(out);
  assert.equal(out.source, "schema");
  assert.equal(out.parameter, "region");
});

test("parseMcpToolFeedback marks known required schema input as tool-level without enum", () => {
  const out = parseMcpToolFeedback({
    schema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      required: ["account_id"],
    },
  });
  assert.ok(out);
  assert.equal(out.parameter, "account_id");
  assert.equal(out.source, "schema");
  assert.equal(out.inputLevel, "tool");
});

test("resolveMcpToolRetryInput uses single candidate", () => {
  const feedback = {
    kind: "missing_required_tool_input" as const,
    parameter: "project_id",
    candidates: ["only-project"],
    source: "tool_error" as const,
  };
  const out = resolveMcpToolRetryInput({}, feedback);
  assert.deepEqual(out, { project_id: "only-project" });
});

test("resolveMcpToolRetryInput maps existing matching value", () => {
  const feedback = {
    kind: "missing_required_tool_input" as const,
    parameter: "project_id",
    candidates: ["proj-a", "proj-b"],
    source: "tool_error" as const,
  };
  const out = resolveMcpToolRetryInput({ name: "proj-a" }, feedback);
  assert.deepEqual(out, { name: "proj-a", project_id: "proj-a" });
});

test("resolveMcpToolRetryInput promotes camelCase alias to required top-level input", () => {
  const feedback = {
    kind: "missing_required_tool_input" as const,
    parameter: "account_id",
    candidates: [],
    source: "tool_error" as const,
    inputLevel: "tool" as const,
  };
  const out = resolveMcpToolRetryInput({ accountId: "acc-123" }, feedback);
  assert.deepEqual(out, { accountId: "acc-123", account_id: "acc-123" });
});

test("resolveMcpToolRetryInput does not promote nested API-style values into top-level required input", () => {
  const feedback = {
    kind: "missing_required_tool_input" as const,
    parameter: "account_id",
    candidates: [],
    source: "tool_error" as const,
    inputLevel: "tool" as const,
  };
  const out = resolveMcpToolRetryInput({ query: { account_id: "acc-q-1" } }, feedback);
  assert.equal(out, null);
});

test("resolveMcpToolRetryInput returns null for ambiguous values", () => {
  const feedback = {
    kind: "missing_required_tool_input" as const,
    parameter: "project_id",
    candidates: ["proj-a", "proj-b"],
    source: "tool_error" as const,
  };
  const out = resolveMcpToolRetryInput({}, feedback);
  assert.equal(out, null);
});

test("resolveMcpToolRetryInput returns null when parameter already present", () => {
  const feedback = {
    kind: "missing_required_tool_input" as const,
    parameter: "project_id",
    candidates: ["proj-a"],
    source: "tool_error" as const,
  };
  const out = resolveMcpToolRetryInput({ project_id: "proj-a" }, feedback);
  assert.equal(out, null);
});

test("getToolEntryDescription extracts description", () => {
  assert.equal(getToolEntryDescription({ description: "hello" }), "hello");
  assert.equal(getToolEntryDescription({}), "");
});

test("getToolEntrySchema prefers parameters over inputSchema", () => {
  const params = { type: "object" };
  const out = getToolEntrySchema({ parameters: params, inputSchema: { type: "x" } });
  assert.equal(out, params);
});
