/**
 * Lightweight Think parent for coder/tester delegation only (Cloudflare Agents sub-agent pattern).
 * MainAgent reaches this DO via `stub.fetch` + JSON — it does **not** call `subAgent(CoderAgent)` itself.
 *
 * @see https://github.com/cloudflare/agents/blob/main/design/rfc-sub-agents.md
 */
import { Think, type Session } from "@cloudflare/think";
import { __DO_NOT_USE_WILL_BREAK__agentContext } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../lib/env";
import { runCodingCollaborationLoop } from "./codingLoop/runCodingCollaborationLoop";
import type {
  CodingCollaborationLoopInput,
  CodingCollaborationLoopResult,
} from "./codingLoop/codingLoopTypes";
import {
  MAX_SUBAGENT_RPC_INBOUND_MESSAGE_CHARS,
  truncateMessageForSubagentRpcInbound,
  type DelegationOptions,
  type SubAgentResult,
} from "./delegation";
import { DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX } from "../debug/debugChildDelegationPrefix";
import { isDebugOrchestrationEnvEnabled } from "../debug/debugOrchestrationWorkerGate";
import { formatSharedDelegationEnvelope } from "../workspace/delegationEnvelope";
import { getSharedWorkspaceGateway } from "../workspace/sharedWorkspaceFactory";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Child naming / RPC delegation — same mechanics as {@link MainAgent#delegateTo},
 * but uses {@link SubagentCoordinatorThink#coordRequestId} instead of MainAgent `requestId`.
 */
export class SubagentCoordinatorThink extends Think<Env> {
  /**
   * Per HTTP invocation id for `coder-${id}` / `tester-${id}` child DO names.
   * Set fresh for each `stub.fetch` handler entry.
   */
  private coordRequestId = `coord-req-${Date.now()}`;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.waitForMcpConnections = false;
    this.chatRecovery = false;
    this.maxSteps = 1;
  }

  override getModel(): LanguageModel {
    if (!this.env.AI) {
      throw new Error("SubagentCoordinatorThink requires Workers AI binding `AI`.");
    }
    return createWorkersAI({ binding: this.env.AI as never })("@cf/meta/llama-3.1-8b-instruct");
  }

  override getSystemPrompt(): string {
    return "Subagent coordinator — delegates to coder/tester; not used for direct chat.";
  }

  override getTools(): ToolSet {
    return {};
  }

  override configureSession(session: Session): Session {
    return session;
  }

  async delegateTo<T extends Think>(
    agentClass: new (ctx: DurableObjectState, env: never) => T,
    name: string,
    message: string,
    options: DelegationOptions = {}
  ): Promise<SubAgentResult> {
    if (options.onEvent != null) {
      throw new Error(
        "delegateTo: options.onEvent is not supported across sub-agent RPC (use in-process chat only)."
      );
    }
    if (options.tools != null && Object.keys(options.tools).length > 0) {
      throw new Error(
        "delegateTo: options.tools cannot be merged across sub-agent RPC; register tools on the child class."
      );
    }

    const safeMessage = truncateMessageForSubagentRpcInbound(message);
    const self = this as unknown as {
      subAgent(
        cls: new (ctx: DurableObjectState, env: never) => T,
        name: string
      ): Promise<{
        rpcCollectChatTurn(msg: string): Promise<SubAgentResult>;
        rpcCollectStatelessModelTurn?(msg: string): Promise<SubAgentResult>;
      }>;
    };

    const stub = await self.subAgent(agentClass, name);
    const originalChars = typeof message === "string" ? message.length : String(message ?? "").length;
    const outboundChars = safeMessage.length;
    const inboundTruncated = originalChars > MAX_SUBAGENT_RPC_INBOUND_MESSAGE_CHARS;
    console.info(
      "delegation_rpc_outbound",
      JSON.stringify({
        childFacetName: name,
        childClass: (agentClass as { name?: string }).name ?? "Think",
        stateless: options.statelessSubAgentModelTurn === true,
        originalMessageChars: originalChars,
        outboundMessageChars: outboundChars,
        inboundTruncated,
        coordRequestId: this.coordRequestId,
      })
    );
    try {
      return await __DO_NOT_USE_WILL_BREAK__agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined,
        },
        async () => {
          if (options.statelessSubAgentModelTurn === true) {
            const alt = stub.rpcCollectStatelessModelTurn;
            if (typeof alt !== "function") {
              throw new Error(
                "delegateTo: statelessSubAgentModelTurn requires the child class to expose @callable rpcCollectStatelessModelTurn (CoderAgent/TesterAgent)."
              );
            }
            return alt.call(stub, safeMessage);
          }
          return stub.rpcCollectChatTurn(safeMessage);
        }
      );
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : String(e);
      const errName = e instanceof Error ? e.name : typeof e;
      console.error(
        "delegation_rpc_failed",
        JSON.stringify({
          coordRequestId: this.coordRequestId,
          childFacetName: name,
          childClass: (agentClass as { name?: string }).name ?? "Think",
          stateless: options.statelessSubAgentModelTurn === true,
          outboundMessageChars: outboundChars,
          errName,
          errMessage: errMessage.length > 3000 ? `${errMessage.slice(0, 3000)}…` : errMessage,
        })
      );
      throw e;
    }
  }

  async delegateToCoder(message: string, options: DelegationOptions = {}): Promise<SubAgentResult> {
    const { CoderAgent } = await import("./subagents/CoderAgent");
    const envelopeObs =
      options.sharedProjectId != null
        ? {
            controlPlaneProjectId: options.controlPlaneProjectId,
            taskId: options.controlPlaneTaskId,
            runId: options.controlPlaneRunId,
          }
        : undefined;
    let body =
      options.sharedProjectId != null
        ? formatSharedDelegationEnvelope(
            options.sharedProjectId,
            "coder",
            message,
            envelopeObs
          )
        : message;
    if (
      options.debugDisableSharedWorkspaceTools === true &&
      isDebugOrchestrationEnvEnabled(this.env)
    ) {
      body = DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX + body;
    }
    const childName =
      options.subAgentInstanceSuffix != null
        ? `coder-${this.coordRequestId}-${options.subAgentInstanceSuffix}`
        : `coder-${this.coordRequestId}`;
    return this.delegateTo(
      CoderAgent as unknown as new (ctx: DurableObjectState, env: never) => Think,
      childName,
      body,
      options
    );
  }

  async delegateToTester(message: string, options: DelegationOptions = {}): Promise<SubAgentResult> {
    const { TesterAgent } = await import("./subagents/TesterAgent");
    const envelopeObs =
      options.sharedProjectId != null
        ? {
            controlPlaneProjectId: options.controlPlaneProjectId,
            taskId: options.controlPlaneTaskId,
            runId: options.controlPlaneRunId,
          }
        : undefined;
    let body =
      options.sharedProjectId != null
        ? formatSharedDelegationEnvelope(
            options.sharedProjectId,
            "tester",
            message,
            envelopeObs
          )
        : message;
    if (
      options.debugDisableSharedWorkspaceTools === true &&
      isDebugOrchestrationEnvEnabled(this.env)
    ) {
      body = DEBUG_EDGECLAW_CHILD_NO_SHARED_TOOLS_PREFIX + body;
    }
    const childName =
      options.subAgentInstanceSuffix != null
        ? `tester-${this.coordRequestId}-${options.subAgentInstanceSuffix}`
        : `tester-${this.coordRequestId}`;
    return this.delegateTo(
      TesterAgent as unknown as new (ctx: DurableObjectState, env: never) => Think,
      childName,
      body,
      options
    );
  }

  async runCoordinatorCodingLoop(
    input: CodingCollaborationLoopInput
  ): Promise<CodingCollaborationLoopResult> {
    const loopRunId = crypto.randomUUID();
    const parentRequestId = this.coordRequestId;
    // Coordinator-hosted loop: always stateless child turns. MainAgent often passes
    // `statelessSubAgentModelTurn: false` via debug `childTurn: "normal"`, which would otherwise
    // keep `rpcCollectChatTurn` (`saveMessages` + Agents SQLite) — fragile under nested facets,
    // deploy-time DO resets, and cross-DO I/O edge cases. Prompts are full per iteration.
    const inputResolved: CodingCollaborationLoopInput = {
      ...input,
      statelessSubAgentModelTurn: true,
    };

    return runCodingCollaborationLoop(
      {
        loopRunId,
        parentRequestId,
        delegateToCoder: (m, o) => this.delegateToCoder(m, o),
        delegateToTester: (m, o) => this.delegateToTester(m, o),
        getOrchestratorGateway: () => getSharedWorkspaceGateway(this.env),
        log: (event, data) => {
          console.info(`[EdgeClaw][coding-loop][coord][${loopRunId}] ${event}`, data);
        },
      },
      inputResolved
    );
  }

  override async onRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/coordinator/coding-loop" || pathname.endsWith("/coordinator/coding-loop")) {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      this.coordRequestId = crypto.randomUUID();
      try {
        const raw = (await request.json()) as { input?: CodingCollaborationLoopInput };
        const input = raw.input;
        if (!input || typeof input.sharedProjectId !== "string" || typeof input.task !== "string") {
          return json({ error: "Body must be JSON { input: CodingCollaborationLoopInput }." }, 400);
        }
        const result = await this.runCoordinatorCodingLoop(input);
        return json(result, 200);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          "coordinator_handler_error",
          JSON.stringify({
            path: "/coordinator/coding-loop",
            coordRequestId: this.coordRequestId,
            message: msg.length > 4000 ? `${msg.slice(0, 4000)}…` : msg,
          })
        );
        return json({ error: msg, debug: true }, 500);
      }
    }

    if (pathname === "/coordinator/delegate-coder" || pathname.endsWith("/coordinator/delegate-coder")) {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      this.coordRequestId = crypto.randomUUID();
      try {
        const raw = (await request.json()) as {
          message?: string;
          options?: DelegationOptions;
        };
        const message = typeof raw.message === "string" ? raw.message : "";
        const options = raw.options ?? {};
        const result = await this.delegateToCoder(message, options);
        return json(result, 200);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          "coordinator_handler_error",
          JSON.stringify({
            path: "/coordinator/delegate-coder",
            coordRequestId: this.coordRequestId,
            message: msg.length > 4000 ? `${msg.slice(0, 4000)}…` : msg,
          })
        );
        return json({ error: msg, debug: true }, 500);
      }
    }

    if (pathname === "/coordinator/delegate-tester" || pathname.endsWith("/coordinator/delegate-tester")) {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      this.coordRequestId = crypto.randomUUID();
      try {
        const raw = (await request.json()) as {
          message?: string;
          options?: DelegationOptions;
        };
        const message = typeof raw.message === "string" ? raw.message : "";
        const options = raw.options ?? {};
        const result = await this.delegateToTester(message, options);
        return json(result, 200);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          "coordinator_handler_error",
          JSON.stringify({
            path: "/coordinator/delegate-tester",
            coordRequestId: this.coordRequestId,
            message: msg.length > 4000 ? `${msg.slice(0, 4000)}…` : msg,
          })
        );
        return json({ error: msg, debug: true }, 500);
      }
    }

    if (pathname === "/coordinator/smoke-coder" || pathname.endsWith("/coordinator/smoke-coder")) {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      this.coordRequestId = crypto.randomUUID();
      try {
        const raw = (await request.json()) as { message?: string };
        const message =
          typeof raw.message === "string" && raw.message.trim()
            ? raw.message.trim()
            : "[smoke] coordinator → coder";
        const result = await this.delegateToCoder(message);
        return json(result, 200);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          "coordinator_handler_error",
          JSON.stringify({
            path: "/coordinator/smoke-coder",
            coordRequestId: this.coordRequestId,
            message: msg.length > 4000 ? `${msg.slice(0, 4000)}…` : msg,
          })
        );
        return json({ error: msg, debug: true }, 500);
      }
    }

    return json({ error: "Not found", pathname }, 404);
  }
}
