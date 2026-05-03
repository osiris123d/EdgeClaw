/** Wire-format types for EdgeclawBrowsingAgent broadcasts (mirrors server `src/browsing/browsingTypes.ts`). */

export type BrowserStatus =
  | "starting"
  | "navigating"
  | "acting"
  | "extracting"
  | "done"
  | "error";

export type BrowserEvent =
  | { type: "browser-screenshot"; data: string }
  | { type: "browser-action"; action: string; step: number }
  | { type: "browser-status"; status: BrowserStatus; message?: string }
  | { type: "browser-error"; error: string }
  | { type: "browser-liveview-url"; url: string };

const BROWSER_EVENT_TYPES = new Set([
  "browser-screenshot",
  "browser-action",
  "browser-status",
  "browser-error",
  "browser-liveview-url",
]);

export function isBrowserEvent(value: unknown): value is BrowserEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.type === "string" && BROWSER_EVENT_TYPES.has(obj.type);
}

const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

export function isValidBase64(value: string): boolean {
  return value.length > 0 && BASE64_RE.test(value);
}
