/**
 * AI Gateway router JSON docs — v1 vs v2 drift guard (no Worker runtime).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = join(here, "..", "..", "..", "docs");

type RouterDoc = {
  name?: string;
  elements?: Array<{
    id?: string;
    type?: string;
    properties?: { conditions?: Record<string, unknown> };
  }>;
};

function loadRouter(filename: string): RouterDoc {
  const raw = readFileSync(join(docsDir, filename), "utf8");
  return JSON.parse(raw) as RouterDoc;
}

/** Stable fingerprint of all conditional branches (metadata.agent / metadata.task routing). */
function conditionalRoutingFingerprint(doc: RouterDoc): string {
  const els = doc.elements ?? [];
  const rows = els
    .filter((e) => e.type === "conditional" && e.properties?.conditions)
    .map((e) => ({ id: e.id ?? "", conditions: e.properties!.conditions }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(rows);
}

const REQUIRED_CONDITIONAL_IDS = [
  "chk-main",
  "chk-coord",
  "chk-coder",
  "chk-tool-agent",
  "chk-tool-task-mcp",
  "chk-tool-task-extapi",
  "chk-tool-task-orch",
  "chk-tool-task-util",
  "chk-brow",
] as const;

test("ai-gateway-agent-router.json and ai-gateway-agent-router-v2.json stay aligned on conditional routing", () => {
  const v1 = loadRouter("ai-gateway-agent-router.json");
  const v2 = loadRouter("ai-gateway-agent-router-v2.json");
  assert.equal(v1.name, "agent-router");
  assert.equal(v2.name, "agent-router");

  const fp1 = conditionalRoutingFingerprint(v1);
  const fp2 = conditionalRoutingFingerprint(v2);
  assert.equal(
    fp1,
    fp2,
    "Update both router docs when changing metadata.agent / metadata.task branching"
  );

  for (const label of ["v1", "v2"] as const) {
    const fp = label === "v1" ? v1 : v2;
    const ids = new Set((fp.elements ?? []).map((e) => e.id).filter(Boolean));
    for (const id of REQUIRED_CONDITIONAL_IDS) {
      assert.ok(ids.has(id), `${label} missing routing element "${id}"`);
    }
  }
});
