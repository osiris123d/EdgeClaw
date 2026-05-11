/**
 * Synthetic MCP relay tools on ToolAgent that forward execution to MainAgent's live MCP SDK tools.
 */

import type { ToolSet } from "ai";
import type { Env } from "../lib/env";
import type { McpMirrorToolDescriptor } from "../lib/mcpToolAgentLiveReuse";
import {
  codemodeWireRawErrorMessage,
  coerceStandaloneStructuredClonePortable,
  isCodemodeWireDebugEnabled,
  logCodemodeWireDelegatedBoundary,
  toDelegatedMcpRpcWireValue,
} from "./codemodeRouterHelpers";

/** Isolate Workers stub lookup — dynamic import keeps Node tests importable without `cloudflare:` scheme. */
async function getNamedAgentStub(namespace: unknown, name: string): Promise<unknown> {
  const { getAgentByName } = await import("agents");
  const resolve = getAgentByName as unknown as (ns: unknown, agentName: string) => Promise<unknown>;
  return resolve(namespace, name);
}

export function buildMcpLiveMirrorToolSet(options: {
  env: Env;
  parentAgentName: string;
  descriptors: Record<string, McpMirrorToolDescriptor>;
}): ToolSet {
  const out: Record<string, unknown> = {};
  const ns = options.env.MAIN_AGENT;
  const parentName = typeof options.parentAgentName === "string" ? options.parentAgentName.trim() : "";
  if (!ns || !parentName) {
    console.warn(
      "[EdgeClaw][tool-agent] MCP live mirror skipped: MAIN_AGENT binding or delegatedParentAgentName missing"
    );
    return out as ToolSet;
  }

  const entries = Object.entries(options.descriptors).filter(([toolName]) =>
    /^tool_[A-Za-z0-9_-]+_(search|execute)$/.test(toolName)
  );
  if (entries.length === 0) return out as ToolSet;

  for (const [toolName, desc] of entries) {
    const mirrorExecute = async (input: unknown): Promise<unknown> => {
      const dbg = isCodemodeWireDebugEnabled();
      const stub = await getNamedAgentStub(ns, parentName);
      type RpcFn = (p: {
        toolName: string;
        input: unknown;
      }) => Promise<{ ok: boolean; resultWire?: string; result?: unknown; error?: string }>;
      const typedStub = stub as { rpcExecuteDelegatedMcpTool?: RpcFn };
      if (typeof typedStub.rpcExecuteDelegatedMcpTool !== "function") {
        throw new Error("[EdgeClaw] MainAgent rpcExecuteDelegatedMcpTool is not available");
      }

      /** Same wire path as MainAgent result — Workers RPC marshals args via structured clone; model/tool args can accidentally hold DO stubs. */
      let wiredInput: unknown;
      try {
        wiredInput = toDelegatedMcpRpcWireValue(input);
      } catch (wireInErr) {
        const msg = codemodeWireRawErrorMessage(wireInErr);
        console.warn(
          `[EdgeClaw][mcpLiveMirrorTools] rpc_arg_input_wire_failed tool=${toolName} direction=toolAgent_to_mainAgent phase=before_stub ` +
            `error=${msg.slice(0, 800)}`
        );
        if (dbg) {
          logCodemodeWireDelegatedBoundary({
            boundaryLabel: "mcpLiveMirrorTools:input_toDelegatedMcpRpcWireValue_threw",
            delegatedMcpToolName: toolName,
            rawExecuteResolved: false,
            errorBeforeNeutralize: msg,
          });
        }
        throw new Error(
          `[EdgeClaw][mirror:input_wire_precall] tool=${toolName}: ${msg} ` +
            `(ToolAgent could not reduce tool args to JSON-safe wire before MainAgent RPC.)`
        );
      }

      const rpcPayload = { toolName, input: wiredInput };
      let payloadJsonBytes = 0;
      let fullPayloadStructuredCloneProbe: "ok" | "fail" | "skipped" = "skipped";
      try {
        payloadJsonBytes = JSON.stringify(rpcPayload).length;
        if (typeof structuredClone === "function") {
          structuredClone(rpcPayload);
          fullPayloadStructuredCloneProbe = "ok";
        } else {
          fullPayloadStructuredCloneProbe = "skipped";
        }
      } catch (preStubErr) {
        const msg = codemodeWireRawErrorMessage(preStubErr);
        console.warn(
          `[EdgeClaw][mcpLiveMirrorTools] rpc_arg_precall_clone_failed tool=${toolName} fullPayloadStructuredCloneProbe=fail error=${msg.slice(0, 800)}`
        );
        if (dbg) {
          logCodemodeWireDelegatedBoundary({
            boundaryLabel: "mcpLiveMirrorTools:rpc_payload_structured_clone_failed_before_stub",
            delegatedMcpToolName: toolName,
            rawExecuteResolved: false,
            errorBeforeNeutralize: msg,
          });
        }
        throw new Error(
          `[EdgeClaw][mirror:rpc_payload_not_cloneable] tool=${toolName}: ${msg}`
        );
      }

      console.warn(
        `[EdgeClaw][mcpLiveMirrorTools] rpc_precall tool=${toolName} direction=toolAgent_to_mainAgent ` +
          `payloadJsonBytes=${payloadJsonBytes} fullPayloadStructuredCloneProbe=${fullPayloadStructuredCloneProbe} ` +
          `invocation_mode=direct_stub_method ` +
          `expect_next_seq=MainAgent_rpcExecuteDelegatedMcp_enter_then_recv`
      );

      let res: { ok: boolean; resultWire?: string; result?: unknown; error?: string };
      try {
        res = await typedStub.rpcExecuteDelegatedMcpTool(rpcPayload);
      } catch (rpcErr) {
        const msg = codemodeWireRawErrorMessage(rpcErr);
        console.warn(
          `[EdgeClaw][mcpLiveMirrorTools] rpc_stub_threw tool=${toolName} error=${msg.slice(0, 800)} ` +
            `hint=if_MainAgent_shows_no_rpcExecuteDelegatedMcp_enter_request_marshal_failed_at_edge`
        );
        if (dbg) {
          logCodemodeWireDelegatedBoundary({
            boundaryLabel: "mcpLiveMirrorTools:rpc_stub_threw",
            delegatedMcpToolName: toolName,
            rawExecuteResolved: false,
            errorBeforeNeutralize: msg,
          });
        }
        throw new Error(
          `[EdgeClaw][mirror-rpc-throw] tool=${toolName}: ${msg}`
        );
      }

      if (!res.ok) {
        if (dbg) {
          logCodemodeWireDelegatedBoundary({
            boundaryLabel: "mcpLiveMirrorTools:rpc_returned_ok_false",
            delegatedMcpToolName: toolName,
            rawExecuteResolved: false,
            errorBeforeNeutralize: (typeof res.error === "string" ? res.error : "").slice(0, 2000),
          });
        }
        throw new Error(
          typeof res.error === "string" && res.error.trimStart().startsWith("[EdgeClaw]")
            ? res.error
            : `[EdgeClaw][mirror:rpc_ok_false] tool=${toolName}: ${typeof res.error === "string" ? res.error : "unknown_error"}`
        );
      }

      let rawFromParent: unknown;
      if (typeof res.resultWire === "string") {
        try {
          rawFromParent = JSON.parse(res.resultWire);
        } catch (parseErr) {
          if (dbg) {
            logCodemodeWireDelegatedBoundary({
              boundaryLabel: "mcpLiveMirrorTools:resultWire_JSON_parse_threw",
              delegatedMcpToolName: toolName,
              rawExecuteResolved: false,
              errorBeforeNeutralize: codemodeWireRawErrorMessage(parseErr),
            });
          }
          throw new Error(
            `[EdgeClaw][mirror:resultWire_JSON_parse] tool=${toolName}: ${codemodeWireRawErrorMessage(parseErr)}`
          );
        }
      } else if (res.result !== undefined) {
        rawFromParent = res.result;
      } else {
        throw new Error(
          "[EdgeClaw] rpcExecuteDelegatedMcpTool succeeded but neither resultWire nor result was returned"
        );
      }
      let wired: unknown;
      try {
        wired = coerceStandaloneStructuredClonePortable(
          toDelegatedMcpRpcWireValue(rawFromParent)
        );
      } catch (mirrorWireErr) {
        if (dbg) {
          logCodemodeWireDelegatedBoundary({
            boundaryLabel: "mcpLiveMirrorTools:mirror_toDelegated_or_standalone_clone_failed",
            delegatedMcpToolName: toolName,
            rawExecuteResolved: false,
            errorBeforeNeutralize: codemodeWireRawErrorMessage(mirrorWireErr),
          });
        }
        throw new Error(
          `[EdgeClaw][mirror:wire_sanitize] tool=${toolName}: ${codemodeWireRawErrorMessage(mirrorWireErr)}`
        );
      }

      if (dbg && typeof structuredClone === "function") {
        try {
          structuredClone(wired);
        } catch {
          logCodemodeWireDelegatedBoundary({
            boundaryLabel: "mcpLiveMirrorTools:mirror_execute_structured_clone_failed",
            delegatedMcpToolName: toolName,
            sanitizedConstructorName:
              wired !== null && wired !== undefined && typeof wired === "object"
                ? ((wired as object).constructor?.name ?? "Object")
                : typeof wired,
            jsonStringifyRoundTripOk: true,
            structuredCloneOk: false,
          });
        }
      }

      return wired;
    };
    const entry: unknown = {
      description: desc.description || `Delegated MCP mirror: ${toolName}`,
      execute: mirrorExecute,
    };
    out[toolName] = entry;
  }

  return out as ToolSet;
}
