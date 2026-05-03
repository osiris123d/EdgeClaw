/**
 * Browser session launch URL sanitization tests.
 *
 * Prevents malformed URLs such as https://amazon.com},/ from being passed to
 * Browser Run target creation when task prose includes trailing JSON syntax.
 */

import { readFileSync } from "node:fs";

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      process.exitCode = 1;
    });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy value, got ${value}`);
}

// Mirror of src/browserSession/providerAdapter.ts extract logic for focused behavior tests.
function sanitizeExtractedUrl(candidate) {
  let sanitized = candidate.trim();
  sanitized = sanitized.replace(/[}\],)"'`]+\/+$/g, "");
  sanitized = sanitized.replace(/[}\],)"'`]+$/g, "");
  return sanitized;
}

function extractLaunchUrl(task) {
  const trimmed = task.trim();
  const match = trimmed.match(/https?:\/\/[^\s)"']+/i);
  if (match?.[0]) return sanitizeExtractedUrl(match[0]);

  const domainMatch = trimmed.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)"']*)?/i);
  if (domainMatch?.[0]) return sanitizeExtractedUrl(`https://${domainMatch[0]}`);

  return "about:blank";
}

test("extractLaunchUrl strips trailing },/ noise from URL", () => {
  const task =
    "Search Amazon and launch this URL: https://amazon.com},/ then continue with actions";

  const url = extractLaunchUrl(task);
  assertEqual(url, "https://amazon.com", "must strip malformed },/ suffix");
});

test("extractLaunchUrl keeps a valid URL unchanged", () => {
  const task = "Open https://amazon.com and search for backpacks";
  const url = extractLaunchUrl(task);
  assertEqual(url, "https://amazon.com", "valid URL should remain intact");
});

test("source contains URL sanitization call before provider target creation", () => {
  const source = readFileSync(
    new URL("../src/browserSession/providerAdapter.ts", import.meta.url),
    "utf8"
  );

  assertTrue(
    source.includes("function sanitizeExtractedUrl(candidate: string): string"),
    "providerAdapter should define sanitizeExtractedUrl"
  );
  assertTrue(
    source.includes("return sanitizeExtractedUrl(match[0]);") &&
      source.includes("return sanitizeExtractedUrl(`https://${domainMatch[0]}`);"),
    "extractLaunchUrl should sanitize both direct URL and domain fallback paths"
  );
});

console.log("\nBrowser session launch URL sanitization tests completed.\n");
