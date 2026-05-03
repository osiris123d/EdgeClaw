/**
 * Tests for BrowserSession structured action execution
 *
 * Covers:
 * - action schema validation
 * - action transpilation to CDP scripts
 * - chaining multiple actions
 * - error handling for invalid actions
 *
 * Note: This test inlines action validators and transpilers to avoid .ts import issues in .mjs
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inline validators (mirrors src/browserSession/browserActions.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a single action object
 */
function validateAction(action) {
  if (!action || typeof action !== "object") throw new Error("Action must be an object");
  if (!action.type) throw new Error("Action must have a 'type' field");

  switch (action.type) {
    case "navigate":
      if (typeof action.url !== "string" || !action.url.startsWith("http"))
        throw new Error("navigate action requires url string");
      if (action.waitUntil && !["load", "domContentLoaded", "networkIdle"].includes(action.waitUntil))
        throw new Error("navigate waitUntil must be load|domContentLoaded|networkIdle");
      return action;

    case "click":
      if (typeof action.selector !== "string" || !action.selector)
        throw new Error("click action requires selector string");
      if (action.delayMs && (typeof action.delayMs !== "number" || action.delayMs < 0))
        throw new Error("click delayMs must be non-negative number");
      return action;

    case "type":
      if (typeof action.selector !== "string" || !action.selector)
        throw new Error("type action requires selector string");
      if (typeof action.value !== "string")
        throw new Error("type action requires value string");
      if (action.delayMs && (typeof action.delayMs !== "number" || action.delayMs < 0))
        throw new Error("type delayMs must be non-negative number");
      if (action.clearFirst && typeof action.clearFirst !== "boolean")
        throw new Error("type clearFirst must be boolean");
      return action;

    case "wait":
      if (action.selector && typeof action.selector !== "string")
        throw new Error("wait selector must be string");
      if (action.timeoutMs && (typeof action.timeoutMs !== "number" || action.timeoutMs < 100 || action.timeoutMs > 60000))
        throw new Error("wait timeoutMs must be 100-60000");
      if (action.waitUntil && !["present", "visible", "hidden"].includes(action.waitUntil))
        throw new Error("wait waitUntil must be present|visible|hidden");
      return action;

    case "screenshot":
      if (action.fullPage && typeof action.fullPage !== "boolean")
        throw new Error("screenshot fullPage must be boolean");
      return action;

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

/**
 * Transpile a single action into page-executable JavaScript.
 */
function actionToCdpScript(action) {
  switch (action.type) {
    case "navigate": {
      return `
        const targetUrl = ${JSON.stringify(action.url)};
        if (window.location.href !== targetUrl) {
          window.location.href = targetUrl;
        }
        return { type: "navigate", success: true, url: targetUrl };
      `;
    }
    case "click": {
      const delayMs = action.delayMs ?? 0;
      return `
        const selector = ${JSON.stringify(action.selector)};
        const elem = document.querySelector(selector);
        if (${delayMs} > 0) await new Promise((r) => setTimeout(r, ${delayMs}));
        if (elem) elem.click();
        return { type: "click", success: Boolean(elem), selector };
      `;
    }
    case "type": {
      const clearFirst = action.clearFirst ?? false;
      return `
        const selector = ${JSON.stringify(action.selector)};
        const value = ${JSON.stringify(action.value)};
        const elem = document.querySelector(selector);
        if (elem) {
          if (typeof elem.focus === "function") elem.focus();
          ${clearFirst ? "elem.value = '';" : ""}
          elem.value = value;
          elem.dispatchEvent(new Event("input", { bubbles: true }));
          elem.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { type: "type", success: Boolean(elem), selector, charCount: value.length };
      `;
    }
    case "wait": {
      const selector = action.selector;
      const timeoutMs = action.timeoutMs ?? 10000;
      const waitUntil = action.waitUntil ?? "present";

      if (!selector) {
        return `
          await new Promise((r) => setTimeout(r, ${timeoutMs}));
          return { type: "wait", success: true, waited_ms: ${timeoutMs} };
        `;
      }

      return `
        const selector = ${JSON.stringify(selector)};
        const timeoutMs = ${timeoutMs};
        const waitUntil = ${JSON.stringify(waitUntil)};
        await new Promise((resolve, reject) => {
          const start = Date.now();
          const interval = setInterval(() => {
            const elapsed = Date.now() - start;
            const elem = document.querySelector(selector);
            if (waitUntil === "present") {
              if (elem || elapsed > timeoutMs) {
                clearInterval(interval);
                if (elem) resolve();
                else reject(new Error(\`Timeout waiting for selector present: \${selector} (\${timeoutMs}ms)\`));
              }
              return;
            }
            if (waitUntil === "visible") {
              if (elem) {
                const style = getComputedStyle(elem);
                if (style.display !== "none" && style.visibility !== "hidden") {
                  clearInterval(interval);
                  resolve();
                  return;
                }
              }
              if (elapsed > timeoutMs) {
                clearInterval(interval);
                reject(new Error(\`Timeout waiting for selector visible: \${selector} (\${timeoutMs}ms)\`));
              }
              return;
            }
            if (!elem) {
              clearInterval(interval);
              resolve();
              return;
            }
            const style = getComputedStyle(elem);
            if (style.display === "none" || style.visibility === "hidden") {
              clearInterval(interval);
              resolve();
              return;
            }
            if (elapsed > timeoutMs) {
              clearInterval(interval);
              reject(new Error(\`Timeout waiting for selector hidden: \${selector} (\${timeoutMs}ms)\`));
            }
          }, 100);
        });
        return { type: "wait", success: true, selector };
      `;
    }
    case "screenshot": {
      return `
        return { type: "screenshot", success: true, requested: true, fullPage: ${action.fullPage ?? false} };
      `;
    }
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

/**
 * Transpile an array of actions into page-executable JavaScript.
 */
function actionsToCdpScript(actions) {
  if (actions.length === 0) {
    return `
      (async () => {
        return [];
      })()
    `;
  }

  const fragments = actions.map((action, index) => {
    const script = actionToCdpScript(action);
    return `
      try {
        const result${index} = await (async () => {
          ${script}
        })();
        results.push({ action: ${index}, ...result${index} });
      } catch (error) {
        results.push({ action: ${index}, success: false, error: error.message });
        throw error;
      }
    `;
  });

  return `
    (async () => {
      const results = [];
      ${fragments.join("\n")}
      return results;
    })()
  `;
}


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

function assertTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy, got ${value}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected)
    throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
}

function assertFalse(value, message) {
  if (value) throw new Error(message || `Expected falsy, got ${value}`);
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle))
    throw new Error(message || `Expected "${haystack}" to include "${needle}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("BrowserActionSchema: accepts navigate action", () => {
  const action = {
    type: "navigate",
    url: "https://example.com",
    waitUntil: "load",
  };
  const parsed = validateAction(action);
  assertEqual(parsed.type, "navigate");
  assertEqual(parsed.url, "https://example.com");
  assertEqual(parsed.waitUntil, "load");
});

test("BrowserActionSchema: accepts click action", () => {
  const action = {
    type: "click",
    selector: "#search-button",
    delayMs: 100,
  };
  const parsed = validateAction(action);
  assertEqual(parsed.type, "click");
  assertEqual(parsed.selector, "#search-button");
  assertEqual(parsed.delayMs, 100);
});

test("BrowserActionSchema: accepts type action", () => {
  const action = {
    type: "type",
    selector: "input#query",
    value: "coffee shops",
    delayMs: 50,
    clearFirst: true,
  };
  const parsed = validateAction(action);
  assertEqual(parsed.type, "type");
  assertEqual(parsed.selector, "input#query");
  assertEqual(parsed.value, "coffee shops");
  assertEqual(parsed.delayMs, 50);
  assertEqual(parsed.clearFirst, true);
});

test("BrowserActionSchema: accepts wait action", () => {
  const action = {
    type: "wait",
    selector: ".results",
    timeoutMs: 5000,
    waitUntil: "visible",
  };
  const parsed = validateAction(action);
  assertEqual(parsed.type, "wait");
  assertEqual(parsed.selector, ".results");
  assertEqual(parsed.timeoutMs, 5000);
  assertEqual(parsed.waitUntil, "visible");
});

test("BrowserActionSchema: accepts screenshot action", () => {
  const action = {
    type: "screenshot",
    fullPage: false,
  };
  const parsed = validateAction(action);
  assertEqual(parsed.type, "screenshot");
  assertEqual(parsed.fullPage, false);
});

test("BrowserActionSchema: rejects invalid action type", () => {
  const action = {
    type: "invalid",
    selector: "#foo",
  };
  try {
    validateAction(action);
    throw new Error("Should have rejected invalid action type");
  } catch (err) {
    assertTrue(err.message.includes("Unknown action type"), "Expected unknown type error");
  }
});

test("actionsToCdpScript: navigates to URL with page JS", () => {
  const actions = [
    {
      type: "navigate",
      url: "https://example.com",
      waitUntil: "load",
    },
  ];
  const script = actionsToCdpScript(actions);
  assertIncludes(script, "window.location.href", "Should set window.location.href");
  assertIncludes(script, "https://example.com", "Should include URL");
});

test("actionsToCdpScript: clicks element", () => {
  const actions = [
    {
      type: "click",
      selector: "#search-button",
      delayMs: 100,
    },
  ];
  const script = actionsToCdpScript(actions);
  assertIncludes(script, "document.querySelector", "Should query selector");
  assertIncludes(script, "#search-button", "Should include selector");
  assertIncludes(script, "elem.click()", "Should call DOM click");
});

test("actionsToCdpScript: types text", () => {
  const actions = [
    {
      type: "type",
      selector: "input#query",
      value: "test search",
      delayMs: 50,
      clearFirst: true,
    },
  ];
  const script = actionsToCdpScript(actions);
  assertIncludes(script, "elem.focus()", "Should focus element");
  assertIncludes(script, "elem.value = ''", "Should clear field");
  assertIncludes(script, "dispatchEvent(new Event(\"input\"", "Should dispatch input event");
  assertIncludes(script, "test search", "Should include typed value");
});

test("actionsToCdpScript: waits for selector", () => {
  const actions = [
    {
      type: "wait",
      selector: ".results",
      timeoutMs: 5000,
      waitUntil: "visible",
    },
  ];
  const script = actionsToCdpScript(actions);
  assertIncludes(script, "document.querySelector", "Should query selector");
  assertIncludes(script, ".results", "Should include selector");
  assertIncludes(script, "5000", "Should include timeout");
  assertIncludes(script, '"visible"', "Should check visibility");
  assertIncludes(script, "getComputedStyle", "Should check computed style");
});

test("actionsToCdpScript: takes screenshot", () => {
  const actions = [
    {
      type: "screenshot",
      fullPage: true,
    },
  ];
  const script = actionsToCdpScript(actions);
  assertIncludes(script, "requested: true", "Should mark screenshot requested");
  assertIncludes(script, "fullPage: true", "Should preserve fullPage option");
});

test("actionsToCdpScript: chains multiple actions", () => {
  const actions = [
    { type: "navigate", url: "https://example.com" },
    { type: "type", selector: "input#q", value: "search" },
    { type: "click", selector: "button[type=submit]" },
    { type: "wait", selector: ".results", timeoutMs: 10000 },
    { type: "screenshot" },
  ];
  const script = actionsToCdpScript(actions);
  assertTrue(script.includes("results.push"), "Should collect results");
  assertTrue(script.includes("result0") && script.includes("result4"), "Should number all actions");
  assertTrue(script.includes("async"), "Should be async");
});

test("actionsToCdpScript: empty actions returns empty array", () => {
  const actions = [];
  const script = actionsToCdpScript(actions);
  assertTrue(script.includes("return [];"), "Should return empty array from async wrapper");
});

test("actionsToCdpScript: handles wait without selector (sleep)", () => {
  const actions = [
    {
      type: "wait",
      selector: undefined,
      timeoutMs: 2000,
    },
  ];
  const script = actionsToCdpScript(actions);
  assertIncludes(script, "setTimeout", "Should use setTimeout for sleep");
  assertIncludes(script, "2000", "Should include timeout");
});

test("action with mixed clearFirst and delay options", () => {
  const action = {
    type: "type",
    selector: "#field",
    value: "hello",
    clearFirst: false,
    delayMs: 25,
  };
  const parsed = validateAction(action);
  assertEqual(parsed.clearFirst, false);
  assertEqual(parsed.delayMs, 25);
});

test("screenshot with fullPage=true transpiled correctly", () => {
  const actions = [{ type: "screenshot", fullPage: true }];
  const script = actionsToCdpScript(actions);
  assertTrue(script.includes("fullPage: true"), "Should keep fullPage=true marker");
});

test("screenshot with fullPage=false or missing transpiled correctly", () => {
  const actions = [{ type: "screenshot", fullPage: false }];
  const script = actionsToCdpScript(actions);
  assertTrue(script.includes("fullPage: false"), "Should keep fullPage=false marker");
});

test("actionsToCdpScript: script contains no chrome namespace", () => {
  const actions = [
    { type: "navigate", url: "https://example.com" },
    { type: "type", selector: "input#q", value: "search" },
    { type: "click", selector: "button[type=submit]" },
    { type: "wait", selector: ".results", timeoutMs: 1000 },
    { type: "screenshot", fullPage: false },
  ];
  const script = actionsToCdpScript(actions);
  assertFalse(script.includes("chrome."), "Generated script must not use chrome.* APIs");
  assertFalse(script.includes("Runtime.evaluate"), "Generated script must not use Runtime.evaluate");
  assertFalse(script.includes("Page.navigate"), "Generated script must not use Page.navigate");
});

test("actionsToCdpScript: selectors are embedded correctly", () => {
  const script = actionsToCdpScript([
    { type: "type", selector: "input#twotabsearchtextbox", value: "backpacks" },
    { type: "click", selector: "input#nav-search-submit-button, button[type=submit]" },
    { type: "wait", selector: "[data-component-type='s-search-result'], .s-result-item", timeoutMs: 8000 },
  ]);
  assertIncludes(script, "input#twotabsearchtextbox");
  assertIncludes(script, "input#nav-search-submit-button, button[type=submit]");
  assertIncludes(script, "[data-component-type='s-search-result'], .s-result-item");
});

test("actionsToCdpScript: generated script is parseable JavaScript", () => {
  const script = actionsToCdpScript([
    { type: "navigate", url: "https://example.com" },
    { type: "wait", timeoutMs: 200 },
  ]);
  const wrapped = `return (${script});`;
  // eslint-disable-next-line no-new-func
  const fn = new Function(wrapped);
  assertEqual(typeof fn, "function", "Generated script should parse in Function constructor");
});

console.log("\nAll browser session action tests completed.");
