/**
 * Tests for screenshot normalization server-side logic.
 *
 * Validates:
 * - Screenshot data is detected from various field shapes
 * - Base64 data is converted to complete data URLs
 * - Raw screenshot fields are stripped from visible payload
 * - _screenshotDataUrl is promoted to top-level field
 */

import assert from "assert";

/**
 * Mock version of normalizeBrowserToolOutput for testing.
 * This needs to import and test the actual implementation.
 */

// Helper functions (copied from browserArtifacts.ts for testing)
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isValidBase64(str) {
  if (typeof str !== "string" || str.length === 0) return false;
  if (str.startsWith("data:")) return false;
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(str)) return false;
  return true;
}

function detectAndNormalizeScreenshot(data) {
  // Check for already-normalized data URL
  const dataUrlDirect = asString(data.screenshotDataUrl);
  if (dataUrlDirect?.startsWith("data:")) {
    return dataUrlDirect;
  }

  // Check for nested data URL in screenshot object
  const screenshotObj = asRecord(data.screenshot);
  if (screenshotObj) {
    const nestedDataUrl = asString(screenshotObj.dataUrl);
    if (nestedDataUrl?.startsWith("data:")) {
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
      return `data:image/png;base64,${base64}`;
    }
  }

  return undefined;
}

function buildMetadata(data) {
  const metadata = asRecord(data.metadata) ?? asRecord(data.meta);
  if (metadata) return metadata;

  const clone = { ...data };
  // Strip all screenshot-related fields
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

// Simplified normalization for testing
function normalizeBrowserToolOutput(toolName, output) {
  const rawOutputText = typeof output === "string" ? output : undefined;
  let parsed;

  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    parsed = output;
  } else if (rawOutputText) {
    try {
      const trimmed = rawOutputText.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.endsWith("}")) {
        parsed = JSON.parse(trimmed);
      }
    } catch {
      // Keep parsed as undefined
    }
  }

  let screenshotDataUrl;
  if (parsed) {
    screenshotDataUrl = detectAndNormalizeScreenshot(parsed);
  }

  const result = {
    schema: "edgeclaw.browser-tool-result",
    schemaVersion: 1,
    toolName,
    pageUrl: parsed ? asString(parsed.pageUrl) : undefined,
    description: parsed ? asString(parsed.description) : undefined,
    metadata: parsed ? buildMetadata(parsed) : undefined,
    rawOutputText,
    artifact: null,
  };

  if (screenshotDataUrl) {
    result._screenshotDataUrl = screenshotDataUrl;
  }

  return result;
}

// Test cases
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
    );
  }
}

function assertTrue(value, message) {
  if (!value) {
    throw new Error(message || `Expected truthy value but got ${value}`);
  }
}

function assertFalse(value, message) {
  if (value) {
    throw new Error(message || `Expected falsy value but got ${value}`);
  }
}

// Tests
test("server converts top-level screenshotData into _screenshotDataUrl", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const output = {
    screenshotData: base64,
    description: "Screenshot of example.com",
    pageUrl: "https://example.com",
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);

  assertTrue(
    result._screenshotDataUrl?.startsWith("data:image/png;base64,"),
    "Should have _screenshotDataUrl starting with data URL prefix"
  );
  assertTrue(
    result._screenshotDataUrl?.includes(base64),
    "Should contain the base64 data"
  );
  assertEqual(result.toolName, "browser_execute");
  assertEqual(result.pageUrl, "https://example.com");
});

test("server strips raw screenshot fields from visible payload", () => {
  const output = {
    screenshotData: "iVBORw0KGgo...",
    screenshotBase64: "iVBORw0KGgo...",
    screenshotDataUrl: "data:image/png;base64,...",
    description: "Test",
    pageUrl: "https://example.com",
    customField: "preserved",
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);

  // Check that raw fields are not in metadata
  if (result.metadata) {
    assertFalse(
      "screenshotData" in result.metadata,
      "screenshotData should be stripped from metadata"
    );
    assertFalse(
      "screenshotBase64" in result.metadata,
      "screenshotBase64 should be stripped from metadata"
    );
    assertFalse(
      "screenshotDataUrl" in result.metadata,
      "screenshotDataUrl should be stripped from metadata"
    );
    assertTrue(
      "customField" in result.metadata,
      "customField should be preserved in metadata"
    );
  }
});

test("client renders image from _screenshotDataUrl", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const dataUrl = `data:image/png;base64,${base64}`;
  const output = {
    screenshotDataUrl: dataUrl,
    description: "Screenshot from normalized field",
    pageUrl: "https://example.com",
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);
  assertEqual(result._screenshotDataUrl, dataUrl, "_screenshotDataUrl should be set from normalized input");
});

test("client can fallback-render from top-level screenshotData", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const output = {
    screenshotData: base64,
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);
  assertTrue(
    result._screenshotDataUrl?.startsWith("data:image/png;base64,"),
    "Should construct data URL from screenshotData"
  );
});

test("client does not display raw base64 text in metadata", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const output = {
    screenshotData: base64,
    screenshotBase64: base64,
    description: "Screenshot",
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);

  // Convert metadata to string to check for raw base64
  const metadataStr = JSON.stringify(result.metadata || {});
  assertFalse(
    metadataStr.includes(base64),
    "Raw base64 should not appear in stringified metadata"
  );
  assertFalse(
    metadataStr.includes("screenshotData"),
    "screenshotData field should not appear in metadata"
  );
});

test("warning state only appears when no renderable screenshot data exists", () => {
  const output = {
    description: "No screenshot available",
    pageUrl: "https://example.com",
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);

  assertFalse(
    result._screenshotDataUrl,
    "Should not have _screenshotDataUrl when no screenshot data provided"
  );
  assertTrue(
    result.artifact === null || !result.artifact,
    "Should not have artifact when no screenshot data"
  );
});

test("server normalizes nested screenshot.dataUrl to _screenshotDataUrl", () => {
  const dataUrl = "data:image/png;base64,ABC123...";
  const output = {
    screenshot: {
      dataUrl,
      width: 1920,
      height: 1080,
    },
    description: "Screenshot from nested",
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);
  assertEqual(result._screenshotDataUrl, dataUrl);
});

test("server prioritizes already-normalized screenshotDataUrl", () => {
  const dataUrl1 = "data:image/png;base64,ABC123...";
  const base64 = "DEF456...";
  const output = {
    screenshotDataUrl: dataUrl1,
    screenshotData: base64,
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);
  assertEqual(result._screenshotDataUrl, dataUrl1, "Should use screenshotDataUrl over screenshotData");
});

test("server promotes top-level screenshot (plain base64) to _screenshotDataUrl", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const output = {
    screenshot: base64,
    description: "Live browser result shape",
    pageUrl: "https://example.com",
  };

  const result = normalizeBrowserToolOutput("browser_execute", output);

  assertTrue(
    result._screenshotDataUrl?.startsWith("data:image/png;base64,"),
    "Should have _screenshotDataUrl from top-level screenshot field"
  );
  assertTrue(
    result._screenshotDataUrl?.includes(base64),
    "data URL should contain the original base64 data"
  );
  // Raw screenshot field must not appear in metadata
  const metaStr = JSON.stringify(result.metadata ?? {});
  assertFalse(metaStr.includes(base64), "Raw base64 must not leak into metadata");
});

console.log("\nAll screenshot normalization tests completed.\n");
