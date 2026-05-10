import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCodemodeAutoFallbackToLegacyTools,
  parseCodemodeToolSurfaceUserPreference,
  resolveCodemodeToolSurfaceCompression,
  type ResolveCodemodeToolSurfaceCompressionInput,
} from "../codemodeToolSurfaceResolve";
function res(
  partial: Partial<ResolveCodemodeToolSurfaceCompressionInput>
): ReturnType<typeof resolveCodemodeToolSurfaceCompression> {
  const full: ResolveCodemodeToolSurfaceCompressionInput = {
    envGloballyAllows: partial.envGloballyAllows ?? true,
    userCodemodeToolSurfaceEnabled: partial.userCodemodeToolSurfaceEnabled ?? true,
    hasLoaderBinding: partial.hasLoaderBinding ?? true,
    codeExecutionEnabled: partial.codeExecutionEnabled ?? true,
    ...partial,
  };
  return resolveCodemodeToolSurfaceCompression(full);
}

test("parseCodemodeAutoFallbackToLegacyTools: false only when explicit false", () => {
  assert.equal(parseCodemodeAutoFallbackToLegacyTools(undefined), true);
  assert.equal(parseCodemodeAutoFallbackToLegacyTools(true), true);
  assert.equal(parseCodemodeAutoFallbackToLegacyTools(false), false);
});

test("parseCodemodeToolSurfaceUserPreference: false only when explicit false", () => {
  assert.equal(parseCodemodeToolSurfaceUserPreference(undefined), true);
  assert.equal(parseCodemodeToolSurfaceUserPreference(true), true);
  assert.equal(parseCodemodeToolSurfaceUserPreference(false), false);
  assert.equal(parseCodemodeToolSurfaceUserPreference(null), true);
});


test("envGloballyAllows=false always loses (settings cannot override kill switch)", () => {
  const r = res({
    envGloballyAllows: false,
    userCodemodeToolSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(r.effective, false);
  assert.equal(r.reason, "disabled_by_env");
});

test("explicit user false → disabled_by_setting (after env passes)", () => {
  const r = res({
    envGloballyAllows: true,
    userCodemodeToolSurfaceEnabled: false,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(r.effective, false);
  assert.equal(r.reason, "disabled_by_setting");
});

test("no loader → disabled_no_loader", () => {
  const r = res({ hasLoaderBinding: false });
  assert.equal(r.effective, false);
  assert.equal(r.reason, "disabled_no_loader");
});

test("code execution off → disabled_code_execution", () => {
  const r = res({ codeExecutionEnabled: false });
  assert.equal(r.effective, false);
  assert.equal(r.reason, "disabled_code_execution");
});

test("all gates pass + user on → enabled_by_setting", () => {
  const r = res({
    envGloballyAllows: true,
    userCodemodeToolSurfaceEnabled: true,
    hasLoaderBinding: true,
    codeExecutionEnabled: true,
  });
  assert.equal(r.effective, true);
  assert.equal(r.reason, "enabled_by_setting");
});

test("combination matrix: env blocks before loader/setting", () => {
  assert.equal(
    res({ envGloballyAllows: false, hasLoaderBinding: false }).reason,
    "disabled_by_env"
  );
  assert.equal(
    res({ envGloballyAllows: false, userCodemodeToolSurfaceEnabled: false }).reason,
    "disabled_by_env"
  );
});

test("combination matrix: loader blocks before code-exec and setting", () => {
  assert.equal(
    res({
      hasLoaderBinding: false,
      codeExecutionEnabled: false,
    }).reason,
    "disabled_no_loader"
  );
});

test("combination matrix: code-exec blocks before user setting", () => {
  assert.equal(
    res({
      codeExecutionEnabled: false,
      userCodemodeToolSurfaceEnabled: false,
    }).reason,
    "disabled_code_execution"
  );
});

test("full 4-toggle matrix: precedence env > loader > code execution > setting", () => {
  const combos: ResolveCodemodeToolSurfaceCompressionInput[] = [];
  for (const envGloballyAllows of [false, true]) {
    for (const hasLoaderBinding of [false, true]) {
      for (const codeExecutionEnabled of [false, true]) {
        for (const userCodemodeToolSurfaceEnabled of [false, true]) {
          combos.push({
            envGloballyAllows,
            hasLoaderBinding,
            codeExecutionEnabled,
            userCodemodeToolSurfaceEnabled,
          });
        }
      }
    }
  }

  for (const input of combos) {
    const { effective, reason } = resolveCodemodeToolSurfaceCompression(input);
    if (!input.envGloballyAllows) {
      assert.equal(effective, false);
      assert.equal(reason, "disabled_by_env");
      continue;
    }
    if (!input.hasLoaderBinding) {
      assert.equal(effective, false);
      assert.equal(reason, "disabled_no_loader");
      continue;
    }
    if (!input.codeExecutionEnabled) {
      assert.equal(effective, false);
      assert.equal(reason, "disabled_code_execution");
      continue;
    }
    if (!input.userCodemodeToolSurfaceEnabled) {
      assert.equal(effective, false);
      assert.equal(reason, "disabled_by_setting");
      continue;
    }
    assert.equal(effective, true);
    assert.equal(reason, "enabled_by_setting");
  }

  assert.equal(combos.length, 16);
});
