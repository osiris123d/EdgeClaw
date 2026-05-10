import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodemodeGuidanceText,
  DEFAULT_CODEMODE_GUIDANCE_NOTES,
  MAX_CODEMODE_GUIDANCE_CHARS,
} from "../codemodeGuidanceSettings";

test("default notes include DEX, OpenAPI flow, knownValues hints", () => {
  assert.match(DEFAULT_CODEMODE_GUIDANCE_NOTES, /cloudflare-dex-health/i);
  assert.match(DEFAULT_CODEMODE_GUIDANCE_NOTES, /openapi_search/);
  assert.match(DEFAULT_CODEMODE_GUIDANCE_NOTES, /knownValues/i);
});

test("buildCodemodeGuidanceText returns undefined when disabled", () => {
  assert.equal(
    buildCodemodeGuidanceText({
      codemodeGuidanceEnabled: false,
      codemodeGuidanceNotes: "hello",
    }),
    undefined
  );
});

test("buildCodemodeGuidanceText returns undefined when enabled but notes whitespace-only", () => {
  assert.equal(buildCodemodeGuidanceText({ codemodeGuidanceEnabled: true, codemodeGuidanceNotes: "  \n" }), undefined);
});

test("buildCodemodeGuidanceText trims and normalizes newlines", () => {
  const out = buildCodemodeGuidanceText({
    codemodeGuidanceEnabled: true,
    codemodeGuidanceNotes: " \r\n  line one \r\n ",
  });
  assert.equal(out, "line one");
});

test("buildCodemodeGuidanceText clamps to max length", () => {
  const long = "x".repeat(MAX_CODEMODE_GUIDANCE_CHARS + 120);
  const out = buildCodemodeGuidanceText({
    codemodeGuidanceEnabled: true,
    codemodeGuidanceNotes: long,
  });
  assert.ok(out);
  assert.ok(out!.length <= MAX_CODEMODE_GUIDANCE_CHARS);
  assert.ok(out!.startsWith("x"));
});

test("omit enabled -> treated as on", () => {
  assert.equal(
    buildCodemodeGuidanceText({ codemodeGuidanceNotes: "explicit" }),
    "explicit"
  );
});
