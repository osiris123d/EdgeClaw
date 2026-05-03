/**
 * Keep-alive cap tests for Cloudflare Browser Run session launch.
 *
 * Verifies oversized keepAliveMs values are clamped to provider max so
 * browser_session launch does not fail when user prompts request 1 hour.
 */

import fs from "node:fs";
import path from "node:path";

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
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function extractKeepAliveMs(urlString) {
  const u = new URL(urlString);
  const raw = u.searchParams.get("keep_alive");
  return raw ? Number(raw) : NaN;
}

test("createBrowserSession clamps keepAliveMs above provider max", async () => {
  const compiledPath = path.resolve(process.cwd(), "dist/browserSession/cloudflareBrowserRunApi.js");
  if (!fs.existsSync(compiledPath)) {
    console.log("(skipped) dist/browserSession/cloudflareBrowserRunApi.js not found; run npm run build first");
    return;
  }

  const requests = [];
  const fakeFetch = async (input) => {
    requests.push(String(input));
    return {
      ok: true,
      json: async () => ({ result: { sessionId: "sess-1" } }),
    };
  };

  const { CloudflareBrowserRunApi } = await import("../dist/browserSession/cloudflareBrowserRunApi.js");
  const api = new CloudflareBrowserRunApi(
    { accountId: "acct_1234", apiToken: "token_1234", authSource: "CLOUDFLARE_BROWSER_API_TOKEN" },
    fakeFetch
  );

  await api.createBrowserSession({ keepAliveMs: 3_600_000 });
  assertEqual(requests.length, 1, "expected one API request");
  assertEqual(
    extractKeepAliveMs(requests[0]),
    1_200_000,
    "keep_alive query should be clamped to provider max"
  );
});

test("createBrowserSession preserves in-range keepAliveMs", async () => {
  const requests = [];
  const fakeFetch = async (input) => {
    requests.push(String(input));
    return {
      ok: true,
      json: async () => ({ result: { sessionId: "sess-2" } }),
    };
  };

  const { CloudflareBrowserRunApi } = await import("../dist/browserSession/cloudflareBrowserRunApi.js");
  const api = new CloudflareBrowserRunApi(
    { accountId: "acct_5678", apiToken: "token_5678", authSource: "CLOUDFLARE_BROWSER_API_TOKEN" },
    fakeFetch
  );

  await api.createBrowserSession({ keepAliveMs: 600_000 });
  assertEqual(extractKeepAliveMs(requests[0]), 600_000, "in-range keep_alive should pass through unchanged");
});

