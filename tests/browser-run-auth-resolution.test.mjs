/**
 * Unit tests for resolveBrowserRunAuth() — the single auth resolution helper.
 *
 * Tests the invariant that token and selectedTokenSource always agree:
 * - Only CLOUDFLARE_BROWSER_API_TOKEN present → selectedTokenSource=CLOUDFLARE_BROWSER_API_TOKEN
 * - Only CLOUDFLARE_API_TOKEN present         → selectedTokenSource=CLOUDFLARE_API_TOKEN
 * - Both present                              → CLOUDFLARE_BROWSER_API_TOKEN wins
 * - Neither present                           → selectedTokenSource=none, token=undefined
 * - Whitespace-only values are treated as absent
 * - Invariant: token and selectedTokenSource always agree
 *
 * The implementation is inlined to match the project test pattern (plain node --test,
 * no TypeScript transpiler). Update this whenever resolveBrowserRunAuth changes in
 * src/browserSession/cloudflareBrowserRunApi.ts.
 */

// ─── inline implementation (mirrored from cloudflareBrowserRunApi.ts) ─────────

function resolveBrowserRunAuth(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
  const browserApiToken = env.CLOUDFLARE_BROWSER_API_TOKEN?.trim() || undefined;
  const apiTokenFallback = env.CLOUDFLARE_API_TOKEN?.trim() || undefined;

  let token;
  let selectedTokenSource;

  if (browserApiToken) {
    token = browserApiToken;
    selectedTokenSource = "CLOUDFLARE_BROWSER_API_TOKEN";
  } else if (apiTokenFallback) {
    token = apiTokenFallback;
    selectedTokenSource = "CLOUDFLARE_API_TOKEN";
  } else {
    token = undefined;
    selectedTokenSource = "none";
  }

  // Invariant
  if ((token !== undefined && selectedTokenSource === "none") ||
      (token === undefined && selectedTokenSource !== "none")) {
    throw new Error(
      `Auth resolution invariant violated: token=${token !== undefined ? "present" : "absent"} selectedTokenSource=${selectedTokenSource}`
    );
  }

  return { accountId, token, selectedTokenSource };
}

// ─── test harness ─────────────────────────────────────────────────────────────

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertUndefined(actual, message) {
  if (actual !== undefined) {
    throw new Error(message ?? `Expected undefined, got ${JSON.stringify(actual)}`);
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

// ─── test cases ──────────────────────────────────────────────────────────────

test("only CLOUDFLARE_BROWSER_API_TOKEN present", () => {
  const auth = resolveBrowserRunAuth({
    CLOUDFLARE_ACCOUNT_ID: "acct-1",
    CLOUDFLARE_BROWSER_API_TOKEN: "browser-token-abc",
  });
  assertEqual(auth.selectedTokenSource, "CLOUDFLARE_BROWSER_API_TOKEN");
  assertEqual(auth.token, "browser-token-abc");
  assertEqual(auth.accountId, "acct-1");
});

test("only CLOUDFLARE_API_TOKEN present", () => {
  const auth = resolveBrowserRunAuth({
    CLOUDFLARE_ACCOUNT_ID: "acct-2",
    CLOUDFLARE_API_TOKEN: "api-token-xyz",
  });
  assertEqual(auth.selectedTokenSource, "CLOUDFLARE_API_TOKEN");
  assertEqual(auth.token, "api-token-xyz");
  assertEqual(auth.accountId, "acct-2");
});

test("both tokens present — CLOUDFLARE_BROWSER_API_TOKEN wins", () => {
  const auth = resolveBrowserRunAuth({
    CLOUDFLARE_ACCOUNT_ID: "acct-3",
    CLOUDFLARE_BROWSER_API_TOKEN: "browser-wins",
    CLOUDFLARE_API_TOKEN: "fallback-loses",
  });
  assertEqual(auth.selectedTokenSource, "CLOUDFLARE_BROWSER_API_TOKEN");
  assertEqual(auth.token, "browser-wins");
});

test("neither token present — selectedTokenSource is none, token is undefined", () => {
  const auth = resolveBrowserRunAuth({
    CLOUDFLARE_ACCOUNT_ID: "acct-4",
  });
  assertEqual(auth.selectedTokenSource, "none");
  assertUndefined(auth.token);
});

test("empty env — accountId and token are undefined, source is none", () => {
  const auth = resolveBrowserRunAuth({});
  assertEqual(auth.selectedTokenSource, "none");
  assertUndefined(auth.token);
  assertUndefined(auth.accountId);
});

test("whitespace-only token values are treated as absent", () => {
  const auth = resolveBrowserRunAuth({
    CLOUDFLARE_BROWSER_API_TOKEN: "   ",
    CLOUDFLARE_API_TOKEN: "   ",
  });
  assertEqual(auth.selectedTokenSource, "none");
  assertUndefined(auth.token);
});

test("invariant — token present implies selectedTokenSource !== none", () => {
  const cases = [
    { CLOUDFLARE_BROWSER_API_TOKEN: "t1" },
    { CLOUDFLARE_API_TOKEN: "t2" },
    { CLOUDFLARE_BROWSER_API_TOKEN: "t1", CLOUDFLARE_API_TOKEN: "t2" },
    {},
  ];
  for (const env of cases) {
    const auth = resolveBrowserRunAuth(env);
    const tokenPresent = auth.token !== undefined;
    const sourceIsNone = auth.selectedTokenSource === "none";
    if (tokenPresent && sourceIsNone) {
      throw new Error(
        `Invariant violated: token present but selectedTokenSource=none (env=${JSON.stringify(env)})`
      );
    }
    if (!tokenPresent && !sourceIsNone) {
      throw new Error(
        `Invariant violated: token absent but selectedTokenSource=${auth.selectedTokenSource} (env=${JSON.stringify(env)})`
      );
    }
  }
});

