/**
 * Contract: Worker `dispatchTurn` must reach the MainAgent DO through `fetch`, not bare RPC,
 * so Think `onStart` initializes `session` before `saveMessages` (local Miniflare / some RPC paths).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("dispatchTurn uses stub.fetch POST /webhook/trigger-turn with JSON prompt (not stub.triggerTurn RPC)", () => {
  const serverPath = join(here, "..", "..", "server.ts");
  const src = readFileSync(serverPath, "utf8");
  const dispatchStart = src.indexOf("async function dispatchTurn");
  assert.ok(dispatchStart >= 0, "server.ts must define dispatchTurn");
  const dispatchEnd = src.indexOf("\n// ── Worker export", dispatchStart);
  const block = dispatchEnd > dispatchStart ? src.slice(dispatchStart, dispatchEnd) : src.slice(dispatchStart, dispatchStart + 4000);

  assert.match(
    block,
    /internalUrl = ["']https:\/\/do\/webhook\/trigger-turn["'][\s\S]*?await stub\.fetch/s,
    "dispatchTurn must POST to internal /webhook/trigger-turn via stub.fetch"
  );
  assert.match(block, /body:\s*JSON\.stringify\s*\(\s*\{\s*\n?\s*prompt:\s*payload\.prompt/s);
  assert.ok(
    !/\bstub\.triggerTurn\s*\(/.test(block),
    "dispatchTurn body must not call stub.triggerTurn() RPC"
  );
});
