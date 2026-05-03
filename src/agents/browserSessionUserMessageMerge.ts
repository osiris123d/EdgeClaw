/**
 * Merge user-pasted `browser_session` launch specs (numbered actions, etc.) into
 * tool args when the model omits `actions`. Applied from `browser_session` `execute`
 * (Think does not run `beforeToolCall` before tool execution; see @cloudflare/think).
 */

import { z } from "zod";
import { BrowserActionSchema, type BrowserAction } from "../browserSession/browserActions";

const ActionsArraySchema = z.array(BrowserActionSchema);

/** Same detection as MainAgent `isExplicitBrowserSessionStructuredCall` (shared for consistency). */
export function isExplicitBrowserSessionStructuredUserMessage(text: string): boolean {
  const normalized = text.toLowerCase();
  const explicitBrowserSessionMention =
    /\bbrowser_session\b/.test(normalized) ||
    /use\s+browser\s*session/.test(normalized) ||
    /call\s+browser\s*session/.test(normalized);
  const explicitStructuredIntent =
    /structured\s+actions?/.test(normalized) ||
    /actions?\s+array/.test(normalized) ||
    /exactly\s+once/.test(normalized) ||
    /"operation"\s*:\s*"launch"/.test(normalized) ||
    /"actions"\s*:\s*\[/.test(normalized) ||
    /operation\s*[:=]\s*launch/.test(normalized);

  return explicitBrowserSessionMention && explicitStructuredIntent;
}

/**
 * Returns validated actions if the user message contains a parseable list
 * (numbered JSON lines, or a JSON array under an "actions" key).
 */
export function tryExtractBrowserActionsFromUserMessage(text: string): BrowserAction[] | undefined {
  if (text.length < 20) return undefined;
  if (!/browser_session|structured\s+actions?|actions?\s*array/i.test(text)) {
    return undefined;
  }

  const fromNumbered: unknown[] = [];
  const lineRe = /^\s*\d+\.\s*(\{[\s\S]*\})\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const m = lineRe.exec(line.trimEnd());
    if (!m) continue;
    try {
      fromNumbered.push(JSON.parse(m[1]!));
    } catch {
      // skip malformed line
    }
  }
  if (fromNumbered.length > 0) {
    const r = ActionsArraySchema.safeParse(fromNumbered);
    if (r.success) return r.data;
  }

  const actionsKey = /"actions"\s*:\s*(\[[\s\S]*\])/.exec(text);
  if (actionsKey) {
    try {
      const raw = JSON.parse(actionsKey[1]!);
      const r = ActionsArraySchema.safeParse(raw);
      if (r.success) return r.data;
    } catch {
      // ignore
    }
  }

  return undefined;
}

/** If the model put chain-of-thought or markdown into `task`, recover a short line from the user message. */
export function sanitizeLaunchTaskForStorage(modelTask: string, userText: string | undefined): string {
  if (!userText) return modelTask.trim();
  const leaky =
    /\*\*|\bWait, the user\b|\bLet me (?:just |check |draft )\b|Example modified per grounding|outs\/launch-|Since I cannot call|internal monologue/i.test(
      modelTask
    );
  const tooLong = modelTask.length > 320;
  if (!leaky && !tooLong) return modelTask.trim();

  const fromUser =
    /(?:^|\n)\s*-\s*task:\s*["']([^"']+)["']/i.exec(userText) ?? /task:\s*["']([^"']{4,500})["']/i.exec(userText);
  if (fromUser) return fromUser[1]!.trim();

  const firstLine = (modelTask.split("\n")[0] ?? modelTask).split("**")[0]!.trim();
  return (firstLine || "Browser session task").slice(0, 240);
}

/**
 * Fills in `actions`, and optionally `keepAliveMs` / `sessionMode` / `recordingEnabled`
 * from the user message for `operation: "launch"` when the model left them out.
 */
export function mergeBrowserSessionLaunchFromUserText(
  userText: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (args.operation !== "launch") return args;
  if (!isExplicitBrowserSessionStructuredUserMessage(userText)) return args;

  const existing = args.actions;
  if (Array.isArray(existing) && existing.length > 0) return args;

  const fromUser = tryExtractBrowserActionsFromUserMessage(userText);
  if (!fromUser?.length) return args;

  const merged: Record<string, unknown> = { ...args, actions: fromUser };
  if (merged.keepAliveMs === undefined) {
    const km = /keepAliveMs\s*:\s*(\d+)/i.exec(userText);
    if (km) {
      const n = parseInt(km[1]!, 10);
      if (n >= 1000 && n <= 3_600_000) merged.keepAliveMs = n;
    }
  }
  if (merged.sessionMode === undefined && /sessionMode\s*:\s*["']reusable["']/i.test(userText)) {
    merged.sessionMode = "reusable";
  }
  if (merged.recordingEnabled === undefined && /recordingEnabled\s*:\s*true/i.test(userText)) {
    merged.recordingEnabled = true;
  }
  return merged;
}
