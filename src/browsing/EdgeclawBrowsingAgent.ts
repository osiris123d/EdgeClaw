/**
 * Dedicated Playwright + Workers AI browsing agent (ported from harshil1712/agent-browsing, MIT).
 * Runs alongside MainAgent; does not share Think session or chat protocol.
 */
import { createWorkersAI } from "workers-ai-provider";
import { callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet,
} from "ai";

import type { Env } from "../lib/env";
import { getRuntimeConfig } from "../lib/env";
import { buildModelBindingsForAiGateway } from "../lib/agentObservability";
import { resolveLanguageModel } from "../models/router";
import { SYSTEM_PROMPT } from "./browsingPrompt";
import {
  type BrowserState,
  createBrowserState,
  ensureBrowserSession,
  closeBrowserSession as closeBrowserSessionFn,
  getSnapshotCdp,
  invalidateSnapshotCdp,
  detectAndSwitchToNewPage,
  resolveSessionId,
} from "./browser/browsingSession";
import type { BrowserEvent } from "./browsingTypes";
import { createTools } from "./browsingTools";
import { fetchLiveViewUrlWithRetry } from "./browsingLiveview";
import { buildBrowsingGatewayModelSelection } from "./browsingAiModel";
import type { BrowsingInferenceBackend } from "./browsingInferenceTypes";

const BROWSING_ACTION_LOG_CAP = 200;

export class EdgeclawBrowsingAgent extends AIChatAgent<Env> {
  private browserState: BrowserState = createBrowserState();
  /** Mirrors browser-action broadcasts for clients that reconnect (e.g. SPA nav). */
  private browsingActionLog: Array<{ action: string; step: number }> = [];
  private lastLiveViewUrl: string | null = null;
  /** User preference from Settings; default Workers AI (direct binding). */
  private browsingInferenceBackend: BrowsingInferenceBackend = "workers-ai";

  private recordBrowserEventForSync(event: BrowserEvent): void {
    if (event.type === "browser-status" && event.status === "starting") {
      this.browsingActionLog = [];
      this.lastLiveViewUrl = null;
      return;
    }
    if (event.type === "browser-liveview-url") {
      this.lastLiveViewUrl = event.url;
      return;
    }
    if (event.type === "browser-action") {
      this.browsingActionLog.push({ action: event.action, step: event.step });
      if (this.browsingActionLog.length > BROWSING_ACTION_LOG_CAP) {
        this.browsingActionLog = this.browsingActionLog.slice(-BROWSING_ACTION_LOG_CAP);
      }
    }
  }

  @callable()
  setBrowsingInferenceBackend(backend: BrowsingInferenceBackend): void {
    if (backend !== "workers-ai" && backend !== "ai-gateway") {
      throw new Error(`[EdgeclawBrowsingAgent] Invalid browsing inference backend: ${String(backend)}`);
    }
    this.browsingInferenceBackend = backend;
  }

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const broadcastEvent = (event: BrowserEvent) => {
      this.recordBrowserEventForSync(event);
      this.broadcast(JSON.stringify(event));
    };

    const tools = createTools({
      getPage: () =>
        ensureBrowserSession(this.browserState, this.env, broadcastEvent),
      getCurrentPageUrl: () => this.browserState.page?.url(),
      broadcastEvent,
      getSnapshotCdp: () => getSnapshotCdp(this.browserState),
      invalidateSnapshotCdp: () => invalidateSnapshotCdp(this.browserState),
      detectAndSwitchToNewPage: (currentPage, knownPageCount) =>
        detectAndSwitchToNewPage(
          this.browserState,
          currentPage,
          knownPageCount,
          broadcastEvent
        ),
    });

    const pruned = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages",
    });

    const useGateway = this.browsingInferenceBackend === "ai-gateway";

    if (useGateway) {
      const token = this.env.AI_GATEWAY_TOKEN?.trim();
      if (!token) {
        throw new Error(
          "[EdgeclawBrowsingAgent] AI Gateway inference requires the AI_GATEWAY_TOKEN secret."
        );
      }
      const rt = getRuntimeConfig(this.env);
      const selection = buildBrowsingGatewayModelSelection(this.env);
      const bindings = buildModelBindingsForAiGateway(token, {
        agent: "BrowserAgent",
        worker: rt.appName || "EdgeClaw",
      });
      const model = resolveLanguageModel(selection, bindings);
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: pruned,
        tools,
        stopWhen: stepCountIs(100),
        abortSignal: options?.abortSignal,
      });
      return result.toUIMessageStreamResponse();
    }

    if (!this.env.AI) {
      throw new Error("[EdgeclawBrowsingAgent] Missing AI binding (Workers AI inference)");
    }
    const workersai = createWorkersAI({
      binding: this.env.AI as never,
    });
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.name,
      }),
      system: SYSTEM_PROMPT,
      messages: pruned,
      tools,
      stopWhen: stepCountIs(100),
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  @callable()
  async closeBrowserSession() {
    await closeBrowserSessionFn(this.browserState);
    this.browsingActionLog = [];
    this.lastLiveViewUrl = null;
  }

  /**
   * Restore Live View URL and action log after the SPA unmounts/remounts or the tab reconnects.
   * Refreshes the DevTools URL from the Browser Run session when possible.
   */
  @callable()
  async syncBrowserUiState(): Promise<{
    liveViewUrl: string | null;
    actions: Array<{ action: string; step: number }>;
    hasActivePage: boolean;
    inferenceBackend: BrowsingInferenceBackend;
  }> {
    const page = this.browserState.page;
    const hasActivePage = !!(page && !page.isClosed());

    let liveViewUrl = this.lastLiveViewUrl;
    if (hasActivePage && this.env.BROWSER) {
      const sessionId = await resolveSessionId(this.env.BROWSER);
      if (sessionId) {
        const fresh = await fetchLiveViewUrlWithRetry(this.env, sessionId);
        if (fresh) {
          liveViewUrl = fresh;
          this.lastLiveViewUrl = fresh;
        }
      }
    }

    return {
      liveViewUrl,
      actions: [...this.browsingActionLog],
      hasActivePage,
      inferenceBackend: this.browsingInferenceBackend,
    };
  }
}
