/**
 * Pure tests for LM transcript repair (no Workers).
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { repairOpenAssistantToolCallsInModelMessages } from "../repairInferenceToolCallHistory";

test("repairOpenAssistantToolCallsInModelMessages: no-op when tool pairs balanced", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "codemode",
          input: { code: "1" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "codemode",
          output: { type: "json", value: { ok: true } },
        },
      ],
    },
    { role: "user", content: "next" },
  ];
  const r = repairOpenAssistantToolCallsInModelMessages(messages);
  assert.equal(r.repairedIds.length, 0);
  assert.equal(r.messages.length, messages.length);
});

test("repairOpenAssistantToolCallsInModelMessages: stubs before user when codemode result missing", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "DEX health MEMHQ2375GK1?" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "functions.codemode:2",
          toolName: "codemode",
          input: { code: "void 0" },
        },
      ],
    },
    { role: "user", content: "Try again?" },
  ];
  const r = repairOpenAssistantToolCallsInModelMessages(messages);
  assert.deepEqual(r.repairedIds, ["functions.codemode:2"]);
  assert.equal(r.messages.length, messages.length + 1);
  const toolRow = r.messages[r.messages.length - 2];
  assert.equal(toolRow.role, "tool");
  assert.ok(Array.isArray(toolRow.content));
  const fp = toolRow.content[0];
  assert.equal(fp?.type, "tool-result");
  assert.equal((fp as { toolCallId?: string }).toolCallId, "functions.codemode:2");
  assert.equal(r.messages.at(-1)?.role, "user");
});

test("repairOpenAssistantToolCallsInModelMessages: trailing orphan before end-of-history gets stub", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "x", input: {} }],
    },
  ];
  const r = repairOpenAssistantToolCallsInModelMessages(messages);
  assert.deepEqual(r.repairedIds, ["t1"]);
  assert.equal(r.messages.at(-1)?.role, "tool");
});
