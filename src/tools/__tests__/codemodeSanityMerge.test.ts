import test from "node:test";
import assert from "node:assert/strict";
import { mergeCompressionWithCodemodeSanity } from "../codemodeSanityMerge";

test("sanity skipped when base compression is already off", () => {
  const m = mergeCompressionWithCodemodeSanity(
    { effective: false, reason: "disabled_by_setting" },
    true,
    { ok: false, reason: "x" },
    true
  );
  assert.equal(m.decision.effective, false);
  assert.equal(m.sanityTelemetryStatus, "skipped");
  assert.equal(m.visibleSanityBanner, null);
  assert.equal(m.fallbackToLegacyCompressionOff, false);
});

test("sanity pass keeps compression enabled", () => {
  const m = mergeCompressionWithCodemodeSanity(
    { effective: true, reason: "enabled_by_setting" },
    true,
    { ok: true, registeredMethods: "a,b" },
    true
  );
  assert.equal(m.decision.effective, true);
  assert.equal(m.decision.reason, "enabled_by_setting");
  assert.equal(m.sanityTelemetryStatus, "ok");
});

test("sanity fail + autoFallback: quiet banner, compression forced off", () => {
  const m = mergeCompressionWithCodemodeSanity(
    { effective: true, reason: "enabled_by_setting" },
    true,
    { ok: false, reason: "rpc:oops" },
    true
  );
  assert.equal(m.decision.effective, false);
  assert.equal(m.decision.reason, "disabled_sanity_failed");
  assert.equal(m.visibleSanityBanner, null);
  assert.equal(m.fallbackToLegacyCompressionOff, true);
  assert.equal(m.sanityTelemetryStatus, "failed");
});

test("sanity fail without autoFallback: visible banner markdown", () => {
  const m = mergeCompressionWithCodemodeSanity(
    { effective: true, reason: "enabled_by_setting" },
    true,
    { ok: false, reason: "missing_meta_tool:tools_find" },
    false
  );
  assert.ok(m.visibleSanityBanner?.includes("sanity check failed"));
});
