/**
 * URL extraction regression tests for extractLaunchUrl.
 *
 * Verifies:
 * - Malformed URLs with trailing punctuation are sanitized (e.g., https://amazon.com},/)
 * - Normal URLs without corruption pass through
 * - Domain detection fallback works
 * - about:blank returned when no URL found
 *
 * Note: This test inlines URL extraction logic to avoid .ts import issues in .mjs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inline URL extraction logic (mirrors src/browserSession/providerAdapter.ts)
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeExtractedUrl(candidate) {
  let sanitized = candidate.trim();

  // Strip common trailing JSON/prose punctuation when a URL was copied from
  // a larger instruction block. Match: } ] , ; : " ' ` . and /
  // Use loop approach to avoid regex metachar issues
  const badChars = /[}\];:"'`.,]/;
  while (sanitized.length > 0 && (badChars.test(sanitized[sanitized.length - 1]) || sanitized.endsWith("/"))) {
    sanitized = sanitized.slice(0, -1);
  }

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message ||
        `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
    );
  }
}

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

test("extractLaunchUrl sanitizes trailing JSON punctuation from URL", () => {
  // User observation: Live View showed https://amazon.com},/
  // This was the exact malformed input caught by regex
  const result = extractLaunchUrl("Search Amazon https://amazon.com},/");
  assertEqual(result, "https://amazon.com", "Should strip trailing },/");
});

test("extractLaunchUrl sanitizes trailing braces and commas", () => {
  const result = extractLaunchUrl("Check https://example.com},");
  assertEqual(result, "https://example.com", "Should strip trailing },");
});

test("extractLaunchUrl sanitizes trailing semicolon and slash", () => {
  const input = "Visit https://test.co.uk;/";
  const result = extractLaunchUrl(input);
  assertEqual(result, "https://test.co.uk", "Should strip trailing ;/");
});

test("extractLaunchUrl sanitizes trailing backtick and bracket", () => {
  const result = extractLaunchUrl("Go to https://site.org`]");
  assertEqual(result, "https://site.org", "Should strip trailing `]");
});

test("extractLaunchUrl preserves normal URL without corruption", () => {
  const result = extractLaunchUrl("Visit https://example.com/path?query=value");
  assertEqual(
    result,
    "https://example.com/path?query=value",
    "Should preserve valid URL with path and query"
  );
});

test("extractLaunchUrl handles URL with port number", () => {
  const result = extractLaunchUrl("Connect to https://localhost:3000/api");
  assertEqual(result, "https://localhost:3000/api", "Should preserve port and path");
});

test("extractLaunchUrl falls back to domain detection", () => {
  const result = extractLaunchUrl("Visit example.com for info");
  assertEqual(result, "https://example.com", "Should detect domain without scheme");
});

test("extractLaunchUrl returns about:blank when no URL found", () => {
  const result = extractLaunchUrl("No URL in this text");
  assertEqual(result, "about:blank", "Should return about:blank as fallback");
});

test("extractLaunchUrl sanitizes multiple trailing punctuation chars", () => {
  const result = extractLaunchUrl("Check https://amazon.com}}}]]]");
  assertEqual(result, "https://amazon.com", "Should strip all trailing punctuation");
});
