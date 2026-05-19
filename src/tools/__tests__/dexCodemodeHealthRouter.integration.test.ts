/**
 * Live-style integration: scripted "recommended" Codemode route for DEX fleet health
 * (no real WorkerLoader / MCP — recorded inner calls validate guardrails).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createCodemodeRelayMetaToolSet } from "../codemodeRelayMetaTools";
import { runCodemodeRouterInvocation } from "../codemodeRouterInvocation";
import {
  formatCodemodeFailureAssistantMarkdown,
  isAssistantReplySilentAfterCodemodes,
} from "../codemodeVisibleFallback";

const DEVICE_NEEDLE = "MEMHQ2375GK1";

function extractPathFromCloudflareInnerCode(code: string): string | undefined {
  const needle = `"path":"`;
  const idx = code.indexOf(needle);
  if (idx === -1) return undefined;
  const start = idx + needle.length;
  const end = code.indexOf('"', start);
  if (end === -1) return undefined;
  return code.slice(start, end);
}

async function execTool(meta: ToolSet, name: string, input: unknown): Promise<unknown> {
  const t = meta[name];
  assert.ok(t && typeof t === "object", `missing meta tool ${name}`);
  const ex = (t as { execute?: (i: unknown) => unknown | Promise<unknown> }).execute;
  assert.equal(typeof ex, "function", `${name}.execute`);
  return (ex as (i: unknown) => Promise<unknown> | unknown)(input);
}

test('live-style DEX health MEMHQ2375GK1 route — openapi_search + resolve ordering; blocks hostname as device_id; visible fallback when codemode "Done"', async () => {
  const searchInnerSources: string[] = [];
  const executeInnerSources: string[] = [];
  const fleetLiveRequestedPaths: string[] = [];
  const goodUuid = "550e8400-e29b-41d4-a716-446655440099";

  const relay: ToolSet = {
    tool_WB0fsUJK_search: tool({
      description: "Search the Cloudflare OpenAPI spec. Products: dex, gateway, …",
      inputSchema: z.object({ code: z.string(), account_id: z.string().optional() }),
      execute: async ({ code }: { code: string }) => {
        searchInnerSources.push(code);
        if (code.includes("EDGECLAW_OPENAPI_DESCRIBE")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  operation: {
                    parameters: [{ name: "device_id", in: "path", required: true }],
                  },
                }),
              },
            ],
          };
        }
        assert.ok(
          code.includes("spec.paths"),
          "openapi_search must route through MCP search inner code referencing spec.paths (host-built), not omit spec scanning"
        );
        assert.ok(
          code.includes('"tag":"dex"') ||
            (/tag/.test(code) && code.includes("dex")),
          "openapi_search inner code should persist tag=dex filter for DEX-health queries"
        );
        const canned = [
          {
            method: "GET",
            path: "/accounts/{account_id}/dex/devices/{device_id}/fleet-status/live",
            summary: "Live DEX fleet status for device",
            tags: ["dex"],
          },
          {
            method: "GET",
            path: "/accounts/{account_id}/dex/fleet-status/devices",
            summary: "List devices",
            tags: ["dex"],
          },
        ];
        return { content: [{ type: "text" as const, text: JSON.stringify(canned) }] };
      },
    }),
    tool_WB0fsUJK_execute: tool({
      description: "Execute JavaScript against Cloudflare API (cloudflare.request). Use search first.",
      inputSchema: z.object({ code: z.string(), account_id: z.string().optional() }),
      execute: async ({ code }: { code: string }) => {
        executeInnerSources.push(code);

        const path = extractPathFromCloudflareInnerCode(code);
        assert.ok(path, "execute inner payload should serialize path");
        if (path.includes("fleet-status/live")) {
          fleetLiveRequestedPaths.push(path);
          assert.ok(
            !path.includes(DEVICE_NEEDLE),
            "never invoke fleet-status/live with hostname/serial as device_id segment"
          );
          assert.ok(
            /\/dex\/devices\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/fleet-status\/live$/i.test(
              path.replace(/\\/g, "/")
            ),
            `fleet-status/live path must carry UUID device_id (${path})`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, result: { status: "ok", deviceId: goodUuid } }),
              },
            ],
          };
        }
        if (path.includes("/dex/fleet-status/devices")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, result: [] }),
              },
            ],
          };
        }
        if (path === "/accounts/account-test/devices") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, result: [] }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result: {} }),
            },
          ],
        };
      },
    }),
  };

  const meta = createCodemodeRelayMetaToolSet({
    relay,
    cloudflareAccountId: "account-test",
  });

  await runCodemodeRouterInvocation(async () => {
    /** 1–2: Prefer tools_find + openapi_search (host OpenAPI filtering) vs ad-hoc referencing `spec`. */
    const findOut = (await execTool(meta, "tools_find", {
      query: `Cloudflare DEX health device overall ${DEVICE_NEEDLE}`,
    })) as { matches: Array<{ name: string }> };
    assert.ok(
      findOut.matches.some((m) => m.name === "tool_WB0fsUJK_search"),
      "tools_find should surface OpenAPI/search tool without filtering opaque ids incorrectly"
    );
    const openapiOut = await execTool(meta, "openapi_search", {
      tag: "dex",
      pathIncludes: "fleet-status",
    });
    assert.equal((openapiOut as { ok?: boolean }).ok, true, "openapi_search should succeed via host inner code");

    /** 3–4: resolve_device_identifier inventories list endpoints BEFORE any curated fleet-status/live UUID call */
    assert.equal(fleetLiveRequestedPaths.length, 0);
    await execTool(meta, "resolve_device_identifier", { hostnameOrSerial: DEVICE_NEEDLE });
    assert.equal(
      fleetLiveRequestedPaths.length,
      0,
      "resolver must List inventory endpoints only — never live with hostname"
    );

    const listPathsExtracted = executeInnerSources
      .map((c) => extractPathFromCloudflareInnerCode(c))
      .filter((p): p is string => Boolean(p));
    for (const p of listPathsExtracted) {
      assert.ok(
        !p.includes(`/devices/${DEVICE_NEEDLE}`),
        `inventory/device list path must never embed hostname as device slug (${p})`
      );
    }

    await execTool(meta, "openapi_describe_operation", {
      method: "GET",
      path: "/accounts/{account_id}/dex/devices/{device_id}/fleet-status/live",
    });

    /** Explicit anti-pattern: hostname in UUID slot should be refused before MCP execute inner call */
    const beforeBad = executeInnerSources.length;
    const hostnameLive = await execTool(meta, "cloudflare_request", {
      method: "GET" as const,
      path: `/accounts/{account_id}/dex/devices/{device_id}/fleet-status/live`,
      operationPathTemplate: "/accounts/{account_id}/dex/devices/{device_id}/fleet-status/live",
      knownValues: { account_id: "account-test", device_id: DEVICE_NEEDLE },
    });
    assert.equal((hostnameLive as { ok?: boolean }).ok, false);
    assert.equal(
      executeInnerSources.length,
      beforeBad,
      "cloudflare_request guards must block hostname path before wrapped execute fires"
    );

    /** “Happy” continuation only after simulated UUID resolution (recommended route) */
    const liveOk = await execTool(meta, "cloudflare_request", {
      method: "GET" as const,
      path: `/accounts/{account_id}/dex/devices/{device_id}/fleet-status/live`,
      operationPathTemplate: "/accounts/{account_id}/dex/devices/{device_id}/fleet-status/live",
      knownValues: { account_id: "account-test", device_id: goodUuid },
    });
    assert.equal((liveOk as { ok?: boolean }).ok, true, `liveOk response: ${JSON.stringify(liveOk)}`);

    /** 5: visible assistant markdown when Codemode fails silently (empty / Done) after resolution woes */
    const syntheticCodemodeErrors = [
      `Codemode tooling failed resolving ${DEVICE_NEEDLE} for fleet-status/live`,
      "no_device_match_after_inventory_scan (DEX inventory scans returned candidates=[])",
    ];
    assert.equal(isAssistantReplySilentAfterCodemodes(""), true);
    assert.equal(isAssistantReplySilentAfterCodemodes("Done"), true);
    const note = formatCodemodeFailureAssistantMarkdown(syntheticCodemodeErrors);
    assert.ok(note.includes("Codemode error"));
    assert.ok(/next step:|tip:/i.test(note), "user-facing notice must carry actionable Tip/Next-step");
    assert.ok(
      note.toLowerCase().includes("uuid") ||
        note.toLowerCase().includes("resolve_device_identifier") ||
        note.toLowerCase().includes("hostname"),
      "notice should steer away from hostname-as-device_id"
    );

    /** openapi_search exercised search MCP at least once via host-built inner snippets */
    assert.ok(searchInnerSources.length >= 1);
  });
});
