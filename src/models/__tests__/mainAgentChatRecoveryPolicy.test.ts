/**
 * MainAgent chat fiber recovery policy (Think hook).
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { ChatRecoveryContext } from "@cloudflare/think";
import {
  computeMainAgentChatRecoveryDecision,
  detectDelegateFinalizedInMessages,
} from "../../agents/mainAgentChatRecoveryPolicy";

function ctx(partial: Partial<ChatRecoveryContext>): ChatRecoveryContext {
  return {
    streamId: "sid",
    requestId: "fiber-req",
    partialText: "",
    partialParts: [],
    recoveryData: {},
    messages: [],
    createdAt: Date.now() - 60_000,
    ...partial,
  } as ChatRecoveryContext;
}

test("recovery: zero partial within window does not continue inference", () => {
  const d = computeMainAgentChatRecoveryDecision(ctx({ partialText: "", partialParts: [] }));
  assert.equal(d.continueInference, false);
  assert.equal(d.shouldNotifyInterruptedNoPartial, true);
});

test("recovery: partial text within window continues", () => {
  const d = computeMainAgentChatRecoveryDecision(ctx({ partialText: "hello", partialParts: [] }));
  assert.equal(d.continueInference, true);
  assert.equal(d.shouldNotifyInterruptedNoPartial, false);
});

test("recovery: partialParts only within window continues", () => {
  const d = computeMainAgentChatRecoveryDecision(
    ctx({
      partialText: "   ",
      partialParts: [{ type: "text", text: "x" }] as ChatRecoveryContext["partialParts"],
    })
  );
  assert.equal(d.continueInference, true);
});

test("recovery: stale interruption outside 5m window does not continue", () => {
  const d = computeMainAgentChatRecoveryDecision(
    ctx({
      createdAt: Date.now() - 6 * 60 * 1_000,
      partialText: "",
      partialParts: [],
    })
  );
  assert.equal(d.continueInference, false);
  assert.equal(d.shouldNotifyInterruptedNoPartial, false);
});

// ── detectDelegateFinalizedInMessages ────────────────────────────────────────

type MsgPart = Record<string, unknown>;
type Msg = { role: string; parts?: MsgPart[] };

function delegateToolCallMsg(): Msg {
  return {
    role: "assistant",
    parts: [
      {
        type: "tool-invocation",
        toolName: "delegate_tool_task",
        toolCallId: "tc1",
        state: "result",
      },
    ],
  };
}

function injectedTextMsg(text = "Here are your Workers scripts."): Msg {
  return {
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

function userMsg(text = "List my Workers scripts."): Msg {
  return { role: "user", parts: [{ type: "text", text }] };
}

function toolResultMsg(): Msg {
  return { role: "tool", parts: [{ type: "tool-result", toolCallId: "tc1", result: "ok" }] };
}

test("detectDelegateFinalizedInMessages: delegate tool call + injected text => true", () => {
  const messages: Msg[] = [
    userMsg(),
    delegateToolCallMsg(),
    toolResultMsg(),
    injectedTextMsg(),
  ];
  assert.equal(detectDelegateFinalizedInMessages(messages), true);
});

test("detectDelegateFinalizedInMessages: delegate tool call without injected text => false", () => {
  const messages: Msg[] = [
    userMsg(),
    delegateToolCallMsg(),
    toolResultMsg(),
    // No finalized text message appended yet.
  ];
  assert.equal(detectDelegateFinalizedInMessages(messages), false);
});

test("detectDelegateFinalizedInMessages: pure text assistant (no delegate) => false", () => {
  // Ordinary partial or complete non-delegation turn should still be recoverable.
  const messages: Msg[] = [
    userMsg(),
    { role: "assistant", parts: [{ type: "text", text: "I can help with that." }] },
  ];
  assert.equal(detectDelegateFinalizedInMessages(messages), false);
});

test("detectDelegateFinalizedInMessages: empty messages => false", () => {
  assert.equal(detectDelegateFinalizedInMessages([]), false);
});

test("detectDelegateFinalizedInMessages: does not cross user-message boundary into previous turn", () => {
  // A previous turn had a finalized delegation; the current turn only has a partial.
  const messages: Msg[] = [
    userMsg("first turn"),
    delegateToolCallMsg(),
    toolResultMsg(),
    injectedTextMsg("Previous turn answer."),
    userMsg("second turn"),
    { role: "assistant", parts: [{ type: "text", text: "Draft..." }] },
  ];
  // Should NOT fire — the finalized delegation is from the previous turn, not the current one.
  assert.equal(detectDelegateFinalizedInMessages(messages), false);
});

test("detectDelegateFinalizedInMessages: non-delegate tool call + text does not trigger", () => {
  const messages: Msg[] = [
    userMsg(),
    {
      role: "assistant",
      parts: [{ type: "tool-invocation", toolName: "browser_search", toolCallId: "tc2" }],
    },
    toolResultMsg(),
    { role: "assistant", parts: [{ type: "text", text: "Here are the results." }] },
  ];
  assert.equal(detectDelegateFinalizedInMessages(messages), false);
});

test("detectDelegateFinalizedInMessages: pure text before delegate call, no text after => false", () => {
  // Text message appears BEFORE the delegate call in message order — not our injection pattern.
  const messages: Msg[] = [
    userMsg(),
    { role: "assistant", parts: [{ type: "text", text: "Some earlier text." }] },
    delegateToolCallMsg(),
    toolResultMsg(),
    // No subsequent text injection after the delegate call.
  ];
  assert.equal(detectDelegateFinalizedInMessages(messages), false);
});
