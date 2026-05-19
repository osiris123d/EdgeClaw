/**
 * Integration tests for tools_call MCP feedback retry loop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createCodemodeRelayMetaToolSet } from "../codemodeRelayMetaTools";
import { runCodemodeRouterInvocation } from "../codemodeRouterInvocation";

async function execTool(meta: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = meta[name];
  assert.ok(t && typeof t === "object", `missing meta tool ${name}`);
  const ex = (t as { execute?: (i: unknown) => unknown | Promise<unknown> }).execute;
  assert.equal(typeof ex, "function", `${name}.execute`);
  return (ex as (i: unknown) => Promise<unknown> | unknown)(input);
}

test("tools_call: single-candidate feedback error -> auto retry", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    my_tool: tool({
      description: "Pass project_id as the project_id parameter.",
      inputSchema: z.object({ project_id: z.string().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = input as Record<string, unknown>;
        if (!inp.project_id) {
          return {
            ok: false,
            error: "Please specify the project_id parameter. Available projects: only-project",
          };
        }
        return { ok: true, projectUsed: inp.project_id };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", { toolName: "my_tool", input: {} })
  )) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.retriedWithFeedback, true);
  assert.equal(callCount, 2);
  assert.equal((result.result as Record<string, unknown>).projectUsed, "only-project");
});

test("tools_call: user value under wrong key matching candidate -> retry", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    project_lister: tool({
      description: "Please specify the project_id parameter.",
      inputSchema: z.object({ project_id: z.string().optional(), name: z.string().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = input as Record<string, unknown>;
        if (!inp.project_id) {
          return {
            ok: false,
            error: "Please specify the project_id parameter. Available projects: proj-alpha, proj-beta",
          };
        }
        return { ok: true, projectUsed: inp.project_id };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", { toolName: "project_lister", input: { name: "proj-alpha" } })
  )) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.retriedWithFeedback, true);
  assert.equal(callCount, 2);
  assert.equal((result.result as Record<string, unknown>).projectUsed, "proj-alpha");
});

test("tools_call: multiple candidates no matching value -> structured feedback", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    env_tool: tool({
      description: "Pass env as the env parameter.",
      inputSchema: z.object({ env: z.string().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = input as Record<string, unknown>;
        if (!inp.env) {
          return {
            ok: false,
            error: "Please specify the env parameter. Available environments: staging, production",
          };
        }
        return { ok: true, deployed: inp.env };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", { toolName: "env_tool", input: {} })
  )) as Record<string, unknown>;

  assert.equal(result.ok, false);
  assert.equal(callCount, 1);
  const feedback = result.feedback as Record<string, unknown>;
  assert.equal(feedback.kind, "missing_required_tool_input");
  assert.equal(feedback.parameter, "env");
  assert.ok(Array.isArray(feedback.candidates));
});

test("tools_call: non-pattern error -> no retry", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    flaky_tool: tool({
      description: "fails",
      inputSchema: z.object({}),
      execute: async (): Promise<any> => {
        callCount++;
        throw new Error("internal server error: connection timeout");
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", { toolName: "flaky_tool", input: {} })
  )) as Record<string, unknown>;

  assert.equal(result.ok, false);
  assert.equal(callCount, 1);
  assert.ok(!result.feedback);
});

test("tools_call: feedback retry also fails -> stops after one retry", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    unstable_tool: tool({
      description: "Pass job_id as the job_id parameter.",
      inputSchema: z.object({ job_id: z.string().optional() }),
      execute: async (): Promise<any> => {
        callCount++;
        throw new Error("Please specify the job_id parameter. Available jobs: job-1");
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", { toolName: "unstable_tool", input: {} })
  )) as Record<string, unknown>;

  assert.equal(result.ok, false);
  assert.equal(result.retriedWithFeedback, true);
  assert.equal(callCount, 2);
});

test("tools_call: parameter already present -> no retry", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    direct_tool: tool({
      description: "Pass project_id as the project_id parameter.",
      inputSchema: z.object({ project_id: z.string() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        return { ok: true, used: (input as { project_id?: string }).project_id };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", { toolName: "direct_tool", input: { project_id: "my-proj" } })
  )) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(callCount, 1);
  assert.ok(!result.retriedWithFeedback);
});

test("tools_call: openapi-style keys do not auto-resolve native MCP parameter", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    native_mcp_tool: tool({
      description: "Pass project_id as the project_id parameter.",
      inputSchema: z.object({ project_id: z.string().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = input as Record<string, unknown>;
        if (!inp.project_id) {
          return {
            ok: false,
            error: "Please specify the project_id parameter. Available projects: proj-x, proj-y",
          };
        }
        return { ok: true };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", {
      toolName: "native_mcp_tool",
      input: { accountId: "acc-123", zoneId: "zone-456" },
    })
  )) as Record<string, unknown>;

  assert.equal(result.ok, false);
  assert.equal(callCount, 1);
  const feedback = result.feedback as Record<string, unknown>;
  assert.equal(feedback.parameter, "project_id");
});

test("tools_call: helper missing account_id -> direct native retry with top-level account_id and no third retry", async () => {
  let callCount = 0;
  const observedInputs: Array<Record<string, unknown>> = [];

  const relay: ToolSet = {
    native_account_tool: tool({
      description: "Native MCP tool. Please specify the account_id parameter as top-level tool input.",
      inputSchema: z.object({
        account_id: z.string().optional(),
        accountId: z.string().optional(),
      }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = (input ?? {}) as Record<string, unknown>;
        observedInputs.push(inp);
        if (!inp.account_id) {
          return {
            ok: false,
            error: "Please specify account_id",
          };
        }
        // Simulate compact native post-processing payload
        return { ok: true, items: [{ id: "r1", status: "active" }], scannedCount: 1, matchedCount: 1 };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", {
      toolName: "native_account_tool",
      input: { accountId: "acc-123" },
    })
  )) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.retriedWithFeedback, true);
  assert.equal(result.retriedDirectNative, true);
  assert.equal(result.semanticKey, "missing_tool_input:account_id");
  assert.equal(callCount, 2, "must call native tool exactly twice (initial + one retry)");
  assert.equal(observedInputs.length, 2);
  assert.equal(observedInputs[0].account_id, undefined, "first call is missing top-level account_id");
  assert.equal(observedInputs[1].account_id, "acc-123", "retry promotes accountId -> top-level account_id");
});

test("tools_call_code: Multiple accounts available -> one direct native retry with top-level account_id and preserved code", async () => {
  let callCount = 0;
  const observedInputs: Array<Record<string, unknown>> = [];
  const code =
    "async () => { return await cloudflare.request({ method: 'GET', path: `/accounts/${accountId}/gateway/rules` }); }";

  const relay: ToolSet = {
    tool_Wbza8VYj_execute: tool({
      description:
        "Native MCP execute tool. Multiple accounts are available; please specify account_id parameter as a top-level tool argument.",
      inputSchema: z.object({
        code: z.string().optional(),
        account_id: z.string().optional(),
      }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = (input ?? {}) as Record<string, unknown>;
        observedInputs.push(inp);

        if (!inp.account_id) {
          return {
            ok: false,
            error: "Multiple accounts available. Please specify account_id parameter",
          };
        }

        // Compact reduced payload shape from successful direct native execution.
        return {
          ok: true,
          findings: [{ id: "rule-1", name: "allow", status: "enabled", type: "gateway_rule" }],
          scannedCount: 1,
          matchedCount: 1,
        };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "7012a2fac757cc12605e0faa9f5d056f",
  });

  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call_code", {
      toolName: "tool_Wbza8VYj_execute",
      code,
    })
  )) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.retriedWithFeedback, true);
  assert.equal(result.retriedDirectNative, true);
  assert.equal(result.semanticKey, "missing_tool_input:account_id");
  assert.equal(callCount, 2, "must call native execute exactly twice (initial + one retry)");
  assert.equal(observedInputs.length, 2, "must not perform a third retry");

  assert.equal(observedInputs[0].account_id, undefined, "first call omits top-level account_id");
  assert.equal(observedInputs[1].account_id, "7012a2fac757cc12605e0faa9f5d056f");
  assert.equal(observedInputs[1].code, code, "direct retry must preserve original code argument");
  assert.ok(!("query" in observedInputs[1]), "recovery must not use query for account_id");
  assert.ok(!("params" in observedInputs[1]), "recovery must not use params for account_id");
  assert.ok(!("knownValues" in observedInputs[1]), "recovery must not use knownValues for account_id");
  assert.ok(!("body" in observedInputs[1]), "recovery must not use body for account_id");

  const payload = result.result as Record<string, unknown>;
  assert.equal(payload.ok, true, "successful direct retry must return success payload");
  assert.equal(payload.scannedCount, 1);
  assert.equal(payload.matchedCount, 1);
});

test("openapi_describe_operation: tool-level missing account_id retries native execute exactly once with top-level account_id", async () => {
  let executeCalls = 0;
  const observedInputs: Array<Record<string, unknown>> = [];

  const relay: ToolSet = {
    tool_Wbza8VYj_execute: tool({
      description:
        "Native execute tool. Multiple accounts available. Please specify account_id parameter as top-level tool input.",
      inputSchema: z.object({ code: z.string().optional(), account_id: z.string().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        executeCalls++;
        const inp = (input ?? {}) as Record<string, unknown>;
        observedInputs.push(inp);
        if (!inp.account_id) {
          throw new Error("Multiple accounts available. Please specify account_id parameter.");
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                operation: {
                  parameters: [{ name: "account_id", in: "path", required: true }],
                },
              }),
            },
          ],
        };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "7012a2fac757cc12605e0faa9f5d056f",
  });

  const out = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
    })
  )) as Record<string, unknown>;

  assert.equal(out.ok, true);
  assert.equal(executeCalls, 2, "must call native execute exactly twice (initial + one retry)");
  assert.equal(observedInputs.length, 2);
  assert.equal(observedInputs[0].account_id, undefined, "first call should be code-only");
  assert.equal(observedInputs[1].account_id, "7012a2fac757cc12605e0faa9f5d056f");
  assert.equal(observedInputs[1].code, observedInputs[0].code, "retry must preserve original code");
  assert.ok(!("query" in observedInputs[1]));
  assert.ok(!("params" in observedInputs[1]));
  assert.ok(!("knownValues" in observedInputs[1]));
  assert.ok(!("body" in observedInputs[1]));
});

test("tools_call: corrected retry that hits authentication error overrides stale missing_tool_input semanticKey", async () => {
  let callCount = 0;
  const relay: ToolSet = {
    secure_native_tool: tool({
      description: "Native MCP tool. Please specify the account_id parameter as top-level tool input.",
      inputSchema: z.object({ account_id: z.string().optional(), code: z.string().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = (input ?? {}) as Record<string, unknown>;
        if (!inp.account_id) {
          return { ok: false, error: "Please specify account_id parameter." };
        }
        return {
          ok: false,
          error: "Cloudflare API error: 10000: Authentication error",
        };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "acct-from-runtime",
  });

  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", { toolName: "secure_native_tool", input: {} })
  )) as Record<string, unknown>;

  assert.equal(result.ok, false);
  assert.equal(result.retriedWithFeedback, true, "one corrected retry should occur");
  assert.equal(callCount, 2, "must run exactly one retry after missing input failure");
  assert.equal(result.semanticKey, "auth_error:provider_auth_failed",
    "later auth error must override stale missing_tool_input semantic key");
});

test("tools_call: ignores nested query/path/knownValues/body values and uses configured runtime account_id for bounded retry", async () => {
  let callCount = 0;
  const seenAccountIds: Array<string | undefined> = [];
  const relay: ToolSet = {
    strict_native_tool: tool({
      description: "Pass account_id as the account_id parameter.",
      inputSchema: z.object({ account_id: z.string().optional(), query: z.any().optional(), path: z.any().optional(), knownValues: z.any().optional(), body: z.any().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        callCount++;
        const inp = (input ?? {}) as Record<string, unknown>;
        seenAccountIds.push(typeof inp.account_id === "string" ? inp.account_id : undefined);
        if (!inp.account_id) {
          return { ok: false, error: "Please specify account_id parameter." };
        }
        return { ok: true, account_id: inp.account_id };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({ relay, cloudflareAccountId: "acct-runtime" });
  const result = (await runCodemodeRouterInvocation(async () =>
    execTool(meta, "tools_call", {
      toolName: "strict_native_tool",
      input: {
        query: { account_id: "acct-query" },
        path: { account_id: "acct-path" },
        knownValues: { account_id: "acct-known" },
        body: { account_id: "acct-body" },
      },
    })
  )) as Record<string, unknown>;

  assert.equal(result.ok, true, "bounded retry should succeed using configured runtime context");
  assert.equal(callCount, 2, "must perform exactly one bounded retry");
  assert.equal(seenAccountIds[0], undefined, "first call must not lift nested container values into top-level input");
  assert.equal(seenAccountIds[1], "acct-runtime", "retry must use configured runtime top-level account_id fallback");
});

test("cloudflare_request: tool-level missing account_id retries relay execute exactly once with top-level account_id", async () => {
  let executeCalls = 0;
  const observedInputs: Array<Record<string, unknown>> = [];

  const relay: ToolSet = {
    tool_Wbza8VYj_search: tool({
      description: "Search stub",
      inputSchema: z.object({ code: z.string().optional() }),
      execute: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ endpoints: [] }) }] }),
    }),
    tool_Wbza8VYj_execute: tool({
      description:
        "Native execute tool. Multiple accounts available. Please specify account_id parameter as top-level tool input.",
      inputSchema: z.object({ code: z.string().optional(), account_id: z.string().optional() }),
      execute: async (input: unknown): Promise<Record<string, unknown>> => {
        executeCalls++;
        const inp = (input ?? {}) as Record<string, unknown>;
        observedInputs.push(inp);
        if (!inp.account_id) {
          throw new Error("Multiple accounts available. Please specify account_id parameter.");
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                result: [{ id: "rule-1", name: "Hilton - Prod" }],
              }),
            },
          ],
        };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "7012a2fac757cc12605e0faa9f5d056f",
  });

  const out = (await runCodemodeRouterInvocation(async () => {
    await execTool(meta, "openapi_search", { tag: "gateway" });
    return execTool(meta, "cloudflare_request", {
      method: "GET",
      path: "/accounts/{account_id}/gateway/rules",
      account_id: "7012a2fac757cc12605e0faa9f5d056f",
    });
  })) as Record<string, unknown>;

  assert.equal(out.ok, true, "final helper result should succeed after direct native retry");
  assert.equal(executeCalls, 2, "must call native execute exactly twice (initial + one retry)");
  assert.equal(observedInputs.length, 2, "no third retry");
  assert.equal(observedInputs[0].account_id, undefined, "first call should be code-only");
  assert.equal(observedInputs[1].account_id, "7012a2fac757cc12605e0faa9f5d056f");
  assert.equal(observedInputs[1].code, observedInputs[0].code, "retry must preserve original code");
  assert.ok(!("query" in observedInputs[1]));
  assert.ok(!("params" in observedInputs[1]));
  assert.ok(!("knownValues" in observedInputs[1]));
  assert.ok(!("body" in observedInputs[1]));

  const resultRows = out.result as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(resultRows), true);
  assert.equal(resultRows[0].id, "rule-1");
  assert.equal(resultRows[0].name, "Hilton - Prod");
});
