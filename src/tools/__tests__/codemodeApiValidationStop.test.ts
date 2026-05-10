/**
 * Repeated structured API-validation failures inside successful Codemode tool payloads
 * (including nested ok:false siblings next to successes).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodemodeApiFailureMarkdownFromTurnState,
  CODEMODE_API_STOP_HEADING,
  CODEMODE_API_VALIDATION_NEXT_STEP_GENERIC,
  CODEMODE_API_VALIDATION_STOP_COUNT,
  createEmptyCodemodeApiTurnStopState,
  formatCodemodeApiFailureAssistantMarkdown,
  normalizeApiValidationFamily,
  recordCodemodeInvocationForApiValidationStop,
  shouldForceCodemodeApiStopFinalVisibleAnswer,
} from "../codemodeApiValidationStop";

/** Serial / hostname from transcript-style naming. */
const MEM_STYLE_SERIAL = "MEMHQ2375GK1";

const DEVICE_UUID_SELECTED = "55c5188a-4a44-11f1-b2d9-22b205b85f53";

function mixedMemhqStructuredOutput(extraParamMissingBranches: unknown[]) {
  return {
    result: {
      resolveDeviceIdentifier: {
        ok: true,
        matchedFromPath: true,
        candidates: [
          { deviceId: DEVICE_UUID_SELECTED, hostname: MEM_STYLE_SERIAL },
          {
            deviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            hostname: "other-unit",
          },
        ],
      },
      fleetStatus: {
        ok: false,
        error: "11004: dex.api.parameter.missing",
        cloudflare_api_error: {
          code: 11004,
          message: "dex.api.parameter.missing",
          path_note: `${MEM_STYLE_SERIAL} is not UUID`,
        },
      },
      warpChangeEvents: {
        ok: false,
        error:
          "{\"code\":11004,\"errors\":[{\"message\":\"11004: dex.api.parameter.missing\"}]}",
      },
      testsOverview: {
        ok: true,
        result: {
          tests: [
            { id: "t-net", ok: true },
            { id: "t-fw", ok: false },
            { id: "t-disk", ok: true },
          ],
          uniqueDevicesTotal: 1,
          devices: [{ id: DEVICE_UUID_SELECTED, lastSeen: "2026-03-03T03:56:54Z" }],
        },
      },
      ...Object.fromEntries(
        extraParamMissingBranches.map((node, idx) => [`extraFleetCall_${idx}`, node])
      ),
    },
  };
}

test("MEMHQ-style mixed payload: successes + nested ok:false; stop when same normalized family reaches threshold", () => {
  const state = createEmptyCodemodeApiTurnStopState();
  assert.equal(CODEMODE_API_VALIDATION_STOP_COUNT, 3);

  const oneInvocation = mixedMemhqStructuredOutput([]);
  recordCodemodeInvocationForApiValidationStop({
    state,
    success: true,
    output: oneInvocation,
    error: undefined,
    routerPlumbingEmergency: false,
  });
  assert.equal(state.stoppedFurtherCodemode, false);
  const mr = state.normalizedFamilyCounts.missing_required_parameter ?? 0;
  const pv = state.normalizedFamilyCounts.provider_specific_error ?? 0;
  assert.ok(
    mr + pv >= 2,
    `expected repeated missing/validation-like families, got ${JSON.stringify(state.normalizedFamilyCounts)}`
  );

  const thirdMissing = {
    ok: false,
    path: "/accounts/x/dex/devices/warp-change-events",
    error: "11004: dex.api.parameter.missing",
  };
  const { justCrossedThreshold } = recordCodemodeInvocationForApiValidationStop({
    state,
    success: true,
    output: mixedMemhqStructuredOutput([thirdMissing]),
    error: undefined,
    routerPlumbingEmergency: false,
  });
  assert.equal(justCrossedThreshold, true);
  assert.equal(state.stoppedFurtherCodemode, true);
  const top = Math.max(...Object.values(state.normalizedFamilyCounts));
  assert.ok(top >= 3);

  const md = buildCodemodeApiFailureMarkdownFromTurnState(state, CODEMODE_API_VALIDATION_NEXT_STEP_GENERIC);
  assert.ok(md && md.includes(CODEMODE_API_STOP_HEADING));
  assert.ok(md!.includes(DEVICE_UUID_SELECTED));
  assert.ok(md!.includes(MEM_STYLE_SERIAL));
  assert.ok(/tests aggregate|3\s+entries/i.test(md!));
  assert.ok(/uniqueDevicesTotal/i.test(md!));
  assert.ok(/:\s*1\b/.test(md!));
  assert.ok(/\b(timestamps\b|observation|\blast[_ ]seen|lastSeen|2026)/i.test(md!));
  assert.ok(/What failed/i.test(md!));
  assert.ok(/openapi_search|Normalized buckets/i.test(md!));

  /** Regression: vendor-coded strings stay in payloads / metadata, buckets stay generic */
  assert.ok(/\bmissing_required_parameter\b|\bprovider_specific_error\b/i.test(md!));
});

test("Three sibling API failures normalize and stop immediately", () => {
  const state = createEmptyCodemodeApiTurnStopState();
  const triple = {
    result: {
      a: { ok: false as const, error: "11004: dex.api.parameter.missing" },
      b: { ok: false as const, error: "dex.api.parameter.missing" },
      c: {
        ok: false as const,
        cloudflare_api_error: { code: 11004, message: "dex.api.parameter.missing" },
      },
    },
  };
  const { justCrossedThreshold } = recordCodemodeInvocationForApiValidationStop({
    state,
    success: true,
    output: triple,
    error: undefined,
    routerPlumbingEmergency: false,
  });
  const bucket = normalizeApiValidationFamily("11004: dex.api.parameter.missing");
  assert.ok(
    bucket === "missing_required_parameter" || bucket === "provider_specific_error",
    `unexpected bucket ${bucket}`
  );
  assert.equal(justCrossedThreshold, true);
  assert.equal(state.stoppedFurtherCodemode, true);
});

test("formatCodemodeApiFailureAssistantMarkdown carries family counts + partials (never bare Done)", () => {
  const uuid = "a1b2c3d4-e5f6-4789-abcd-ef1234567890";
  const md = formatCodemodeApiFailureAssistantMarkdown({
    successfulFindings: [
      `**Resource identifier** \`${uuid}\` (needle \`${MEM_STYLE_SERIAL}\`).`,
    ],
    failedCalls: [`result.branch · missing_required_parameter — preview`],
    familyCounts: [
      { family: "missing_required_parameter", count: 3 },
      { family: "invalid_path_identifier", count: 1 },
    ],
    nextStep: CODEMODE_API_VALIDATION_NEXT_STEP_GENERIC,
  });

  assert.match(md, new RegExp(uuid));
  assert.ok(md.includes("### Partial results"));
  assert.ok(/What failed/i.test(md));
  assert.ok(md.includes("missing_required_parameter"));
  assert.ok(md.includes("× 3"));
  assert.ok(!/^done\.?$/im.test(md.replace(/\s+/g, " ").trim()));
});

test("shouldForceCodemodeApiStopFinalVisibleAnswer flags Done and conversational trailers", () => {
  assert.equal(shouldForceCodemodeApiStopFinalVisibleAnswer("Done"), true);
  assert.equal(shouldForceCodemodeApiStopFinalVisibleAnswer("Let me fetch the overview"), true);
  assert.equal(shouldForceCodemodeApiStopFinalVisibleAnswer("Finished: here is the table."), false);
});

test("router plumbing emergency: nested API-validation tally skipped", () => {
  const state = createEmptyCodemodeApiTurnStopState();
  const bad = mixedMemhqStructuredOutput([]);
  for (let i = 0; i < 5; i += 1) {
    recordCodemodeInvocationForApiValidationStop({
      state,
      success: true,
      output: bad,
      error: undefined,
      routerPlumbingEmergency: true,
    });
  }
  assert.equal(Object.keys(state.normalizedFamilyCounts).length, 0);
  assert.equal(state.validationEvents.length, 0);
  assert.equal(state.stoppedFurtherCodemode, false);
});
