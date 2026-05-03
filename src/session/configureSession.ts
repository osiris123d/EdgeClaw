/**
 * Think-native session configuration utilities.
 *
 * This module centralizes durable context blocks, memory settings, and
 * long-conversation compaction for all agents.
 */

import type { Session } from "@cloudflare/think";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { R2SkillProvider } from "agents/experimental/memory/session";

type SessionContextOptions = Parameters<Session["withContext"]>[1];

/**
 * Runtime compaction settings.
 *
 * Compaction is non-destructive in Think/agents Session:
 * - raw message history remains persisted
 * - compaction stores a summary overlay for older ranges
 * - newer messages are preserved verbatim for active turns
 */
export interface SessionCompactionOptions {
  enabled?: boolean;
  tokenThreshold?: number;
  protectHead?: number;
  tailTokenBudget?: number;
  minTailMessages?: number;
  /**
   * Model-backed summarizer used by macro-compaction overlays.
   * Must be provided by the agent so summarization quality tracks runtime model policy.
   */
  summarize?: (prompt: string) => Promise<string>;
}

/**
 * Reusable options for configureSession(session).
 */
export interface SessionConfigurationOptions {
  soulPrompt?: string;
  appName?: string;
  memoryDescription?: string;
  memoryMaxTokens?: number;
  enableCachedPrompt?: boolean;
  compaction?: SessionCompactionOptions;
  additionalContexts?: Array<{
    label: string;
    options?: SessionContextOptions;
  }>;
  /**
   * R2 bucket powering the "skills" context block.
   *
   * When provided, a `SkillProvider`-backed context block named "skills" is
   * registered after "memory".  The SDK injects skill metadata (key + description
   * for every skill in the bucket) into the system prompt on every turn so the
   * model always knows what capabilities are available.  Full skill content is
   * loaded on demand when the model calls the `load_context` tool, and unloaded
   * via `unload_context` when no longer needed to free context space.
   *
   * Leave undefined to skip skills registration (e.g. when SKILLS_BUCKET is
   * not bound or ENABLE_SKILLS=false).
   */
  skillsBucket?: R2Bucket;
}

const DEFAULT_MEMORY_DESCRIPTION =
  "Durable facts learned across the conversation. Keep this concise, factual, and useful for future turns.";

const DEFAULT_MEMORY_MAX_TOKENS = 4000;
const DEFAULT_COMPACTION_THRESHOLD = 80_000;

/**
 * Normalise the app name used in soul prompts.
 * All soul content — identity, persona, behavior rules — belongs in the
 * caller (MainAgent.configureSession). This function only ensures the name
 * is never empty.
 */
export function buildSoulPrompt(soulText: string): string {
  return soulText.trim();
}

/**
 * Configure a Think Session with stable system behavior, durable memory,
 * cached prompt support, and compaction plumbing.
 *
 * Context blocks (registered in order):
 * - "soul"   (readonly):       stable assistant behavior and operating rules
 * - "memory" (writable):       durable learned facts persisted by Session providers
 * - "skills" (SkillProvider):  optional — only registered when `skillsBucket` is
 *                               provided.  Skill metadata (key + description) is
 *                               always present in the system prompt; full content
 *                               is loaded on demand via the `load_context` tool
 *                               and unloaded via `unload_context` when done.
 *
 * Long conversation handling:
 * - `compactAfter(tokenThreshold)` triggers compaction checks as history grows
 * - `onCompaction(...)` creates non-destructive summary overlays for old ranges
 * - underlying message history remains stored for auditing/recovery
 */
export function configureSession(
  session: Session,
  options: SessionConfigurationOptions = {}
): Session {
  if (!options.soulPrompt) {
    throw new Error("configureSession: soulPrompt is required. Pass it from the agent's configureSession() override.");
  }
  const soulPrompt = options.soulPrompt;
  const memoryDescription = options.memoryDescription ?? DEFAULT_MEMORY_DESCRIPTION;
  const memoryMaxTokens = options.memoryMaxTokens ?? DEFAULT_MEMORY_MAX_TOKENS;
  const enableCachedPrompt = options.enableCachedPrompt ?? true;
  const compaction = options.compaction ?? {};
  const compactionEnabled = compaction.enabled ?? true;
  const compactionThreshold = compaction.tokenThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const skillsEnabled = options.skillsBucket != null;

  console.info(
    `[EdgeClaw][session-config] cachedPrompt=${enableCachedPrompt ? "enabled" : "disabled"} ` +
      `compaction=${compactionEnabled ? "enabled" : "disabled"} ` +
      `compactionThresholdTokens=${compactionThreshold} ` +
      `memoryMaxTokens=${memoryMaxTokens} ` +
      `skills=${skillsEnabled ? "enabled" : "disabled"}`
  );

  let configured = session
    .withContext("soul", {
      provider: {
        get: async () => soulPrompt,
      },
    })
    // No provider specified: Session.create(...) auto-wires durable writable storage.
    .withContext("memory", {
      description: memoryDescription,
      maxTokens: memoryMaxTokens,
    });

  // Skills context — registered only when an R2 bucket is available.
  // R2SkillProvider.get() renders skill metadata (key + description) into the
  // system prompt on every turn so the model always knows what skills exist.
  // Full skill content is loaded on demand via the SDK's `load_context` tool,
  // and freed via `unload_context` when the model is done using a skill.
  if (skillsEnabled) {
    configured = configured.withContext("skills", {
      provider: new R2SkillProvider(options.skillsBucket!, { prefix: "skills/" }),
    });
  }

  for (const block of options.additionalContexts ?? []) {
    configured = configured.withContext(block.label, block.options);
  }

  if (enableCachedPrompt) {
    configured = configured.withCachedPrompt();
  }

  if (compactionEnabled) {
    if (!compaction.summarize) {
      throw new Error(
        "configureSession: compaction is enabled but no model-backed summarize() callback was provided."
      );
    }

    const summarize = compaction.summarize;
    configured = configured
      .onCompaction(
        createCompactFunction({
          summarize,
          protectHead: compaction.protectHead,
          tailTokenBudget: compaction.tailTokenBudget,
          minTailMessages: compaction.minTailMessages,
        })
      )
      .compactAfter(compactionThreshold);
  }

  return configured;
}
