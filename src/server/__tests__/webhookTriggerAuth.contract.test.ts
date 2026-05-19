/**
 * Contract: /webhook/trigger requires authenticated automation token and keeps all
 * non-trigger routes unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("POST /webhook/trigger verifies token before payload parsing/dispatch", () => {
  const serverPath = join(here, "..", "..", "server.ts");
  const src = readFileSync(serverPath, "utf8");
  assert.match(src, /WEBHOOK_TRIGGER_TOKEN_HEADER\s*=\s*["']X-EdgeClaw-Webhook-Token["']/);
  assert.match(
    src,
    /if \(pathname === ["']\/webhook\/trigger["'] && request\.method === ["']POST["']\) \{[\s\S]*?verifyWebhookTriggerAutomationToken\(request, env\)[\s\S]*?parseWebhookPayload\(request\)[\s\S]*?dispatchTurn\(env, payloadOrError\)/s,
    "trigger route enforces token before parsing/dispatch"
  );
});

test("missing token returns 401", () => {
  const serverPath = join(here, "..", "..", "server.ts");
  const src = readFileSync(serverPath, "utf8");
  assert.match(
    src,
    /function verifyWebhookTriggerAutomationToken\([\s\S]*?if \(!expectedToken \|\| !providedToken \|\| !secureEqualsConstantTime\(providedToken, expectedToken\)\) \{[\s\S]*?return json\(\{ error: ["']Unauthorized["'] \}, 401\);/s,
    "missing token must be unauthorized"
  );
});

test("invalid token returns 401 with constant-time compare", () => {
  const serverPath = join(here, "..", "..", "server.ts");
  const src = readFileSync(serverPath, "utf8");
  assert.match(src, /function secureEqualsConstantTime\(/, "constant-time helper exists");
  assert.match(src, /mismatch \|= l \^ r;/, "compare runs fixed-length xor loop");
  assert.match(src, /return mismatch === 0;/, "constant-time helper returns equality only");
  assert.match(
    src,
    /!secureEqualsConstantTime\(providedToken, expectedToken\)[\s\S]*?return json\(\{ error: ["']Unauthorized["'] \}, 401\);/s,
    "invalid token must be unauthorized"
  );
});

test("other routes remain unchanged by token gate", () => {
  const serverPath = join(here, "..", "..", "server.ts");
  const src = readFileSync(serverPath, "utf8");
  assert.match(
    src,
    /if \(pathname === ["']\/webhook\/scheduled["'] && request\.method === ["']POST["']\) \{[\s\S]*?parseWebhookPayload\(request\)[\s\S]*?dispatchTurn\(env, payloadOrError\)/s,
    "scheduled webhook path remains as-is"
  );
  assert.doesNotMatch(
    src,
    /if \(pathname === ["']\/webhook\/scheduled["'] && request\.method === ["']POST["']\) \{[\s\S]*?verifyWebhookTriggerAutomationToken\(/s,
    "scheduled webhook must not be gated by trigger token"
  );
});

test("no delegation/toolagent/codemode files carry webhook token logic", () => {
  const mainAgentPath = join(here, "..", "..", "agents", "MainAgent.ts");
  const toolAgentPath = join(here, "..", "..", "agents", "subagents", "ToolAgentThinkFacet.ts");
  const codemodePath = join(here, "..", "..", "tools", "codemodeRouterHelpers.ts");
  const mainSrc = readFileSync(mainAgentPath, "utf8");
  const toolSrc = readFileSync(toolAgentPath, "utf8");
  const codemodeSrc = readFileSync(codemodePath, "utf8");

  for (const s of [mainSrc, toolSrc, codemodeSrc]) {
    assert.ok(!s.includes("EDGECLAW_WEBHOOK_TOKEN"), "webhook token logic must stay in server ingress only");
    assert.ok(!s.includes("X-EdgeClaw-Webhook-Token"), "webhook header must stay in server ingress only");
  }
});
