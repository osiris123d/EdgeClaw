/**
 * MCP OAuth callback host resolution tests (Node-safe).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../env";
import {
  resolveMcpOAuthCallbackHostFromEnv,
  resolveMcpOAuthCallbackHostForToolAgentDelegation,
} from "../mcpOAuthCallbackHost";

test("resolveMcpOAuthCallbackHostFromEnv reads Variables.EDGECLAW_PUBLIC_ORIGIN", () => {
  const env = {
    Variables: { EDGECLAW_PUBLIC_ORIGIN: "https://edge.example/path/" },
  } as Env;
  assert.equal(resolveMcpOAuthCallbackHostFromEnv(env), "https://edge.example");
});

test("resolveMcpOAuthCallbackHostFromEnv reads top-level EDGECLAW_PUBLIC_ORIGIN", () => {
  const env = {
    EDGECLAW_PUBLIC_ORIGIN: "https://top.example/",
  } as Env;
  assert.equal(resolveMcpOAuthCallbackHostFromEnv(env), "https://top.example");
});

test("resolveMcpOAuthCallbackHostForToolAgentDelegation falls back to env when no agent request", async () => {
  const env = {
    Variables: { EDGECLAW_PUBLIC_ORIGIN: "https://fallback.example" },
  } as Env;
  const origin = await resolveMcpOAuthCallbackHostForToolAgentDelegation(env);
  assert.equal(origin, "https://fallback.example");
});
