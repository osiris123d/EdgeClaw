/**
 * Runtime boundary tests for `assertOrchestratorPromotionBoundary`.
 * Uses standalone constructors so Node does not load `MainAgent` (Workers / `cloudflare:` imports).
 * Run: `npm run test:coding-loop-e2e`
 */

import assert from "node:assert/strict";
import test from "node:test";
import { assertOrchestratorPromotionBoundary } from "../orchestratorPromotionBoundary";

class Orchestrator {}
class DelegatedSubAgent extends Orchestrator {}

test("boundary accepts orchestrator constructor identity", () => {
  assertOrchestratorPromotionBoundary({ constructor: Orchestrator }, Orchestrator);
});

test("boundary rejects subclass constructor (simulates CoderAgent vs MainAgent)", () => {
  assert.throws(
    () => assertOrchestratorPromotionBoundary({ constructor: DelegatedSubAgent }, Orchestrator),
    /Orchestrator-only APIs/
  );
});
