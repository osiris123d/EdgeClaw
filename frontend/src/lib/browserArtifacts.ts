import type { ActivityStep, BrowserToolResult } from "../types";

export interface BrowserArtifactDisplayItem {
  stepId: string;
  toolName: string;
  pageUrl?: string;
  caption?: string;
  previewUrl?: string;
  screenshotDataUrl?: string;
  binaryRef?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  rawMetadata?: Record<string, unknown>;
  rawOutputText?: string;
  status: "image" | "warning";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isBrowserToolResult(value: unknown): value is BrowserToolResult {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schema === "edgeclaw.browser-tool-result" &&
      record.schemaVersion === 1 &&
      typeof record.toolName === "string"
  );
}

/**
 * Extracts screenshot data URL from BrowserToolResult with fallback logic.
 *
 * Looks for (in order):
 * 1. parsed._screenshotDataUrl (server-normalized)
 * 2. parsed.extractedContent.screenshotDataUrl
 * 3. parsed.extractedContent.screenshot.dataUrl
 * 4. parsed.extractedContent.screenshotBase64
 * 5. parsed.screenshotData as top-level base64 fallback
 *
 * If base64 is found, reconstructs as data URL.
 */
function extractScreenshotDataUrl(
  parsed: Record<string, unknown> | undefined
): string | undefined {
  if (!parsed) return undefined;

  // 1. Check for server-normalized _screenshotDataUrl
  if (typeof parsed._screenshotDataUrl === "string") {
    console.debug("[EdgeClaw] Using server-normalized _screenshotDataUrl");
    return parsed._screenshotDataUrl;
  }

  // 2. Check extractedContent.screenshotDataUrl
  const extractedContent = asRecord(parsed.extractedContent);
  if (extractedContent && typeof extractedContent.screenshotDataUrl === "string") {
    console.debug("[EdgeClaw] Using extractedContent.screenshotDataUrl");
    return extractedContent.screenshotDataUrl;
  }

  // 3. Check extractedContent.screenshot.dataUrl
  if (extractedContent) {
    const screenshot = asRecord(extractedContent.screenshot);
    if (screenshot && typeof screenshot.dataUrl === "string") {
      console.debug("[EdgeClaw] Using extractedContent.screenshot.dataUrl");
      return screenshot.dataUrl;
    }
  }

  // 4. Check extractedContent.screenshotBase64
  if (extractedContent && typeof extractedContent.screenshotBase64 === "string") {
    const base64 = extractedContent.screenshotBase64;
    if (isValidBase64Client(base64)) {
      const dataUrl = `data:image/png;base64,${base64}`;
      console.debug("[EdgeClaw] Reconstructed data URL from extractedContent.screenshotBase64");
      return dataUrl;
    }
  }

  // 5. Check top-level screenshotData as base64 fallback
  if (typeof parsed.screenshotData === "string") {
    const base64 = parsed.screenshotData;
    if (isValidBase64Client(base64)) {
      const dataUrl = `data:image/png;base64,${base64}`;
      console.debug("[EdgeClaw] Reconstructed data URL from top-level screenshotData");
      return dataUrl;
    }
  }

  // 6. Check top-level `screenshot` as a plain base64 string (live browser tool shape)
  if (typeof parsed.screenshot === "string") {
    const base64 = parsed.screenshot;
    if (isValidBase64Client(base64)) {
      const dataUrl = `data:image/png;base64,${base64}`;
      console.debug("[EdgeClaw] Reconstructed data URL from top-level screenshot (raw base64)");
      return dataUrl;
    }
  }

  return undefined;
}

/**
 * Client-side validation that a string appears to be valid base64.
 */
function isValidBase64Client(str: string): boolean {
  if (typeof str !== "string" || str.length === 0) return false;
  // Already a data URL
  if (str.startsWith("data:")) return false;
  // Simple base64 format check
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(str);
}

export function hasImageArtifact(result: BrowserToolResult | undefined): boolean {
  return Boolean(result?.artifact && (result.artifact.url || result.artifact.binaryRef));
}

export function getBrowserArtifactDisplayItems(steps: ActivityStep[]): BrowserArtifactDisplayItem[] {
  return steps
    .filter((step) => step.toolName === "browser_execute" && step.status === "completed" && step.toolResult)
    .map((step) => {
      const result = step.toolResult as BrowserToolResult;
      const artifact = result.artifact;
      const screenshotDataUrl = extractScreenshotDataUrl(result as unknown as Record<string, unknown>);

      // If we have a rendering-ready screenshot data URL, render image
      if (screenshotDataUrl) {
        console.debug("[EdgeClaw] Rendering screenshot from extracted data URL");
        return {
          stepId: step.id,
          toolName: result.toolName,
          pageUrl: result.pageUrl,
          caption: result.description,
          screenshotDataUrl,
          mimeType: artifact?.mimeType,
          width: artifact?.width,
          height: artifact?.height,
          rawMetadata: result.metadata,
          rawOutputText: result.rawOutputText,
          status: "image",
        };
      }

      // Fallback to artifact-based rendering (existing behavior)
      if (artifact && (artifact.url || artifact.binaryRef)) {
        return {
          stepId: step.id,
          toolName: result.toolName,
          pageUrl: result.pageUrl,
          caption: result.description,
          previewUrl: artifact.url,
          binaryRef: artifact.binaryRef,
          mimeType: artifact.mimeType,
          width: artifact.width,
          height: artifact.height,
          rawMetadata: result.metadata,
          rawOutputText: result.rawOutputText,
          status: "image",
        };
      }

      // No screenshot found – warning state
      return {
        stepId: step.id,
        toolName: result.toolName,
        pageUrl: result.pageUrl,
        caption: result.description,
        rawMetadata: result.metadata,
        rawOutputText: result.rawOutputText,
        status: "warning",
      };
    });
}
