import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateAiGatewayLogSummaries,
  parseAiGatewayAccountAndGatewayFromCompatBaseUrl,
} from "../aiGatewayLogQuery";

test("parseAiGatewayAccountAndGatewayFromCompatBaseUrl parses v1 compat URL", () => {
  const u = parseAiGatewayAccountAndGatewayFromCompatBaseUrl(
    "https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/openai/compat"
  );
  assert.deepEqual(u, { accountId: "my-account", gatewayId: "my-gateway" });
});

test("aggregateAiGatewayLogSummaries sums tokens and cost", () => {
  const agg = aggregateAiGatewayLogSummaries([
    {
      id: "a",
      created_at: "2026-01-01T00:00:00Z",
      model: "x",
      provider: "p",
      success: true,
      tokens_in: 10,
      tokens_out: 20,
      cost: 0.001,
    },
    {
      id: "b",
      created_at: "2026-01-01T00:01:00Z",
      model: "y",
      provider: "p",
      success: false,
      tokens_in: 5,
      tokens_out: 0,
    },
  ]);
  assert.equal(agg.tokensIn, 15);
  assert.equal(agg.tokensOut, 20);
  assert.equal(agg.totalCost, 0.001);
});
