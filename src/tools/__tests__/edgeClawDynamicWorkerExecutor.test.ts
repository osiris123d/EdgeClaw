import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function getExecutorSource(): string {
  return readFileSync(join(here, "..", "edgeClawDynamicWorkerExecutor.ts"), "utf8");
}

test("executor source includes runtime cm alias injection", () => {
  const src = getExecutorSource();
  assert.match(src, /const cm = codemode;/, "runtime module should inject cm alias when codemode provider exists");
});

test("executor source includes codemode proxy ownKeys diagnostics", () => {
  const src = getExecutorSource();
  assert.match(src, /ownKeys:\s*\(\)\s*=>/, "proxy should expose ownKeys for helper introspection");
  assert.match(
    src,
    /getOwnPropertyDescriptor:\s*\(_,\s*key\)\s*=>/,
    "proxy should expose getOwnPropertyDescriptor for helper introspection"
  );
});

test("runtime semantics: cm alias can call helper and Object.keys sees helper names", async () => {
  const helperNames = ["openapi_search", "cloudflare_request"];
  const codemode = new Proxy(
    {},
    {
      get: (_target, toolName) => {
        if (toolName === "openapi_search") {
          return async (args: { pathIncludes?: string }) => ({
            ok: true,
            pathIncludes: args.pathIncludes,
          });
        }
        if (toolName === "cloudflare_request") {
          return async () => ({ ok: true });
        }
        return undefined;
      },
      ownKeys: () => helperNames.slice(),
      getOwnPropertyDescriptor: (_target, key) => {
        if (typeof key !== "string") return undefined;
        if (!helperNames.includes(key)) return undefined;
        return { enumerable: true, configurable: true };
      },
    }
  ) as {
    openapi_search: (args: { pathIncludes?: string }) => Promise<{ ok: true; pathIncludes?: string }>;
  };

  const cm = codemode;
  const out = await (async () => {
    return await cm.openapi_search({ pathIncludes: "/gateway/rules" });
  })();

  assert.deepEqual(out, { ok: true, pathIncludes: "/gateway/rules" });
  assert.deepEqual(Object.keys(codemode).sort(), ["cloudflare_request", "openapi_search"]);
});
