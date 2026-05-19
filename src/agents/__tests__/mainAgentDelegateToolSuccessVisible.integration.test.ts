import assert from "node:assert/strict";
import test from "node:test";
import { finalizeSuccessAware } from "../toolAgentSuccessAwareFinalization";
import { computeDelegateToolTaskTurnLatchesAndReply } from "../delegateToolTaskTurnOutcome";

function injectSuccessVisibleMessageLikeMainAgent(args: {
  existingVisibleText: string;
  replyText: string;
  latch: { inserted: boolean };
  appended: string[];
}): string {
  const replyText = args.replyText.trim();
  if (!replyText || args.latch.inserted) {
    return args.existingVisibleText;
  }

  const normalizedExistingText = args.existingVisibleText.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedReplyText = replyText.replace(/\s+/g, " ").trim().toLowerCase();

  if (
    normalizedExistingText.length > 0 &&
    normalizedReplyText.length > 0 &&
    normalizedExistingText.includes(normalizedReplyText)
  ) {
    args.latch.inserted = true;
    return args.existingVisibleText;
  }

  args.appended.push(replyText);
  args.latch.inserted = true;
  return args.existingVisibleText.length > 0
    ? `${args.existingVisibleText}\n\n${replyText}`
    : replyText;
}

test("closest-available integration: nested delegated success renders one visible markdown table injection", () => {
  const nestedPayload = JSON.stringify({
    ok: true,
    result: {
      success: true,
      result: {
        scannedCount: 597,
        matchedCount: 2,
        rules: [
          { id: "r-1", name: "Allow One" },
          { id: "r-2", name: "Allow Two" },
        ],
      },
    },
  });

  const successAware = finalizeSuccessAware({
    synthesisText: `[tools_call]\n${nestedPayload}`,
    resultText: "",
    errorText: "",
    hadToolActivity: true,
  });

  assert.equal(successAware.shouldBeSuccess, true);
  assert.ok((successAware.extractedResult ?? "").includes("| rule id | rule name |"));

  const { latches, reply } = computeDelegateToolTaskTurnLatchesAndReply({
    taskKind: "mcp_api",
    rpc: {
      ok: true,
      text: "",
      toolAgentResult: {
        ok: true,
        resultText: successAware.extractedResult,
        scannedCount: successAware.scannedCount,
        matchedCount: successAware.matchedCount,
        matched: successAware.matched,
      },
    },
  });

  assert.equal(latches.delegateOk, true);
  assert.ok(reply.includes("| rule id | rule name |"));

  const appended: string[] = [];
  const latch = { inserted: false };
  const preamble = "Done. I checked your request.";

  const afterFirst = injectSuccessVisibleMessageLikeMainAgent({
    existingVisibleText: preamble,
    replyText: reply,
    latch,
    appended,
  });

  assert.equal(appended.length, 1, "exactly one assistant-visible injection should occur");
  assert.ok(afterFirst.includes("| rule id | rule name |"));

  const afterSecond = injectSuccessVisibleMessageLikeMainAgent({
    existingVisibleText: afterFirst,
    replyText: reply,
    latch,
    appended,
  });

  assert.equal(appended.length, 1, "duplicate table must not be injected");
  const headerCount = (afterSecond.match(/\| rule id \| rule name \|/g) ?? []).length;
  assert.equal(headerCount, 1, "table header appears exactly once in visible assistant text");
});
