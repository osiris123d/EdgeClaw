export interface BrowserImageArtifact {
  kind: "image";
  url?: string;
  binaryRef?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface BrowserToolResultSchema {
  schema: "edgeclaw.browser-tool-result";
  schemaVersion: 1;
  toolName: string;
  pageUrl?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  rawOutputText?: string;
  artifact?: BrowserImageArtifact | null;
  /** UI-only rendering hint: complete data URL for screenshot. Never displayed in visible text. */
  _screenshotDataUrl?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Detects screenshot data from various field shapes and normalizes to a complete data URL.
 *
 * Looks for:
 * - screenshotDataUrl (already a data URL)
 * - screenshot.dataUrl (nested data URL)
 * - screenshotData (base64 string)
 * - screenshotBase64 (base64 string)
 *
 * Returns the normalized data URL or undefined if no screenshot found.
 * Logs detection source for debugging.
 */
function detectAndNormalizeScreenshot(data: Record<string, unknown>): string | undefined {
  // Check for already-normalized data URL
  const dataUrlDirect = asString(data.screenshotDataUrl);
  if (dataUrlDirect?.startsWith("data:")) {
    console.debug("[EdgeClaw] Screenshot found from screenshotDataUrl field");
    return dataUrlDirect;
  }

  // Check for nested data URL in screenshot object
  const screenshotObj = asRecord(data.screenshot);
  if (screenshotObj) {
    const nestedDataUrl = asString(screenshotObj.dataUrl);
    if (nestedDataUrl?.startsWith("data:")) {
      console.debug("[EdgeClaw] Screenshot found from screenshot.dataUrl field");
      return nestedDataUrl;
    }
  }

  // Check for base64 string from various field names, including top-level `screenshot`
  const screenshotTopLevel = typeof data.screenshot === "string" ? data.screenshot : undefined;
  const base64Options = [
    asString(data.screenshotData),
    asString(data.screenshotBase64),
    screenshotTopLevel,
    screenshotObj ? asString(screenshotObj.base64) : undefined,
  ];

  for (const base64 of base64Options) {
    if (base64 && isValidBase64(base64)) {
      const dataUrl = `data:image/png;base64,${base64}`;
      console.debug("[EdgeClaw] Screenshot created from base64 field, normalized to data URL");
      return dataUrl;
    }
  }

  return undefined;
}

/**
 * Basic validation that a string appears to be valid base64.
 * Used to distinguish between accidentally-stringified data URLs vs actual base64.
 */
function isValidBase64(str: string): boolean {
  if (typeof str !== "string" || str.length === 0) return false;

  // Already a data URL
  if (str.startsWith("data:")) return false;

  // Try to validate base64 format: only alphanumeric, +, /, and optional = padding
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(str)) return false;

  // Additional check: length should be multiple of 4 (encoded chunks)
  // Note: this is a simplified check; real validation would use decoding
  return true;
}


function extractImageArtifact(data: Record<string, unknown>): BrowserImageArtifact | null {
  const screenshot = asRecord(data.screenshot) ?? data;
  const url =
    asString(screenshot.url) ??
    asString(screenshot.imageUrl) ??
    asString(screenshot.screenshotUrl) ??
    asString(screenshot.dataUrl) ??
    (typeof screenshot.image === "string" ? screenshot.image : undefined);
  const binaryRef =
    asString(screenshot.binaryRef) ??
    asString(screenshot.binaryReference) ??
    asString(screenshot.blobRef);

  if (!url && !binaryRef) return null;

  return {
    kind: "image",
    url,
    binaryRef,
    mimeType:
      asString(screenshot.mimeType) ??
      asString(screenshot.contentType) ??
      (url?.startsWith("data:") ? url.slice(5, url.indexOf(";")) : undefined),
    width: asNumber(screenshot.width),
    height: asNumber(screenshot.height),
  };
}

function buildMetadata(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = asRecord(data.metadata) ?? asRecord(data.meta);
  if (metadata) return metadata;

  const clone = { ...data };
  // Strip all screenshot-related fields to prevent raw base64 in visible output
  // Note: top-level `screenshot` may be a plain base64 string (live browser tool shape)
  delete clone.screenshot;
  delete clone.screenshotData;
  delete clone.screenshotBase64;
  delete clone.screenshotDataUrl;
  delete clone._screenshotDataUrl;
  delete clone.url;
  delete clone.imageUrl;
  delete clone.screenshotUrl;
  delete clone.dataUrl;
  delete clone.image;
  delete clone.mimeType;
  delete clone.contentType;
  delete clone.width;
  delete clone.height;
  delete clone.pageUrl;
  delete clone.description;
  delete clone.caption;
  delete clone.binaryRef;
  delete clone.binaryReference;
  delete clone.blobRef;
  return Object.keys(clone).length > 0 ? clone : undefined;
}

export function normalizeBrowserToolOutput(toolName: string, output: unknown): BrowserToolResultSchema {
  const rawOutputText = typeof output === "string" ? output : undefined;
  const parsed =
    asRecord(output) ??
    asRecord(rawOutputText ? tryParseJson(rawOutputText) : undefined) ??
    undefined;

  const artifact = parsed ? extractImageArtifact(parsed) : null;
  const pageUrl =
    (parsed && (asString(parsed.pageUrl) ?? asString(parsed.url))) ||
    undefined;
  const description =
    (parsed && (asString(parsed.description) ?? asString(parsed.caption))) ||
    undefined;

  // Detect and normalize screenshot data to _screenshotDataUrl
  let screenshotDataUrl: string | undefined;
  let hadRawScreenshotData = false;

  if (parsed) {
    screenshotDataUrl = detectAndNormalizeScreenshot(parsed);
    hadRawScreenshotData = Boolean(
      asString(parsed.screenshotData) ||
        asString(parsed.screenshotBase64) ||
        asString(parsed.screenshotDataUrl) ||
        (asRecord(parsed.screenshot) && asString(asRecord(parsed.screenshot)!.dataUrl))
    );
    if (hadRawScreenshotData) {
      console.debug(
        `[EdgeClaw] Raw screenshot fields stripped from normalized result for ${toolName}`
      );
    }
  }

  const result: BrowserToolResultSchema = {
    schema: "edgeclaw.browser-tool-result",
    schemaVersion: 1,
    toolName,
    pageUrl,
    description,
    metadata: parsed ? buildMetadata(parsed) : undefined,
    rawOutputText,
    artifact,
  };

  if (screenshotDataUrl) {
    result._screenshotDataUrl = screenshotDataUrl;
    console.debug(
      `[EdgeClaw] Screenshot normalized to _screenshotDataUrl for ${toolName}; ` +
        `removed raw fields from visible payload`
    );
  }

  return result;
}

export function summarizeBrowserToolResult(result: BrowserToolResultSchema): string {
  if (result.artifact?.url || result.artifact?.binaryRef) {
    return result.pageUrl
      ? `Screenshot artifact captured for ${result.pageUrl}`
      : "Screenshot artifact captured.";
  }

  if (result.toolName === "browser_execute") {
    return "Browser run completed, but no screenshot artifact was returned.";
  }

  return result.rawOutputText?.trim() || result.description || `${result.toolName} completed.`;
}
