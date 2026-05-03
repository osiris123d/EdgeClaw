/**
 * Staging operational summary — read-only, no network beyond KV when bound.
 * Run: `npm run test:promotion-integration`
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../../lib/env";
import {
  buildStagingOperationalSummary,
  runStagingPromotionSmoke,
} from "../promotionOperationalStaging";

test("empty env: noop aggregation flags match diagnostics branches", () => {
  const s = buildStagingOperationalSummary({} as Env);
  assert.equal(s.artifactPromotionWriter, "noop");
  assert.equal(s.noopFallbackFlags.promotionWriterNoop, true);
  assert.equal(s.noopFallbackFlags.anySubsystemNoop, true);
});

test("runStagingPromotionSmoke without SHARED_WORKSPACE_KV skips prepare probe", async () => {
  const smoke = await runStagingPromotionSmoke({} as Env);
  assert.equal(smoke.prepareProbe.outcome, "skipped_no_shared_workspace_kv");
});
