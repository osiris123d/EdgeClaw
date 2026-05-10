/**
 * Pure OpenAPI execution planner — vendor-agnostic.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildOpenApiExecutionPlan,
  validateOpenApiExecutionPlan,
  isHostInjectedPathOrAccountSlot,
} from "../codemodeOpenApiExecutionPlan";
import {
  createEmptyCodemodeApiTurnStopState,
  recordCodemodeInvocationForApiValidationStop,
} from "../codemodeApiValidationStop";

const OP_LIST: Record<string, unknown> = {
  parameters: [{ name: "filter", in: "query", required: true, schema: { type: "string" } }],
};

test("missing required query param yields missing_required_parameter with slot locations", () => {
  const r = buildOpenApiExecutionPlan({
    method: "GET",
    path: "/things",
    operation: OP_LIST as Record<string, unknown>,
    proposedQuery: {},
  });
  assert.ok(r && r.ok === false);
  if (r.ok === false) assert.equal(r.details.missing[0]?.inLocation, "query");
});

test("path template filled from knownValues (preferred over absent proposal)", () => {
  const r = buildOpenApiExecutionPlan({
    method: "GET",
    path: "/widgets/{slot_id}",
    knownValues: { slot_id: "abc-uuid-1" },
    operation: {
      parameters: [
        {
          name: "slot_id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
    },
  });
  assert.ok(r && r.ok === true);
  if (r?.ok) assert.ok(r.renderedPath.includes("abc-uuid-1"));
});

test("planner module stays free of trademark / vendor literals", async () => {
  const plannerPath = path.join(
    process.cwd(),
    "src/tools/codemodeOpenApiExecutionPlan.ts"
  );
  const text = await fs.readFile(plannerPath, "utf8");
  const low = text.toLowerCase();
  assert.equal(/\bcloudflare\b/.test(low), false);
  assert.equal(/\bdex\b/.test(low), false);
  assert.equal(/\bwarp\b/.test(low), false);
});

test("host-injected placeholders do not contribute required path/query missing noise", () => {
  assert.equal(isHostInjectedPathOrAccountSlot("account_id"), true);
});

test("execution plan validates enum rejects after build", () => {
  const op: Record<string, unknown> = {
    parameters: [
      {
        name: "tier",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["a", "b"] },
      },
    ],
  };
  const r = buildOpenApiExecutionPlan({
    method: "GET",
    path: "/plans",
    operation: op,
    proposedQuery: { tier: "nope" },
  });
  assert.ok(r && r.ok === true);
  assert.equal(validateOpenApiExecutionPlan({ plan: r, operation: op }).ok, false);
});

test("reliability layer still counts nested ok:false siblings", () => {
  const state = createEmptyCodemodeApiTurnStopState();
  const triple = {
    result: {
      a: { ok: false as const, error: "missing_required_parameter" },
      b: { ok: false as const, error: "another" },
      c: { ok: false as const, cloudflare_api_error: { code: 1 } },
    },
  };
  recordCodemodeInvocationForApiValidationStop({
    state,
    success: true,
    output: triple,
    error: undefined,
    routerPlumbingEmergency: false,
  });
  assert.ok(state.validationEvents.length >= 3);
});
