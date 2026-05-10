/**
 * Mirrors `@cloudflare/codemode` DynamicWorkerExecutor + ToolDispatcher but registers
 * each sandbox tool under its **own RpcTarget method name** (e.g. `tools_find`).
 *
 * Cloudflare Rpc stubs invoked as `dispatcher.tools_find(input)` serialize to an RPC method
 * `tools_find` on the receiver. The stock ToolDispatcher only implements `call`, so direct
 * `arguments[0].codemode.tools_find(...)` (or any bypass of the sandbox Proxy) yields
 * "RPC receiver does not implement the method ...".
 */

import type { ExecuteResult, Executor, ResolvedProvider } from "@cloudflare/codemode";
import { normalizeCode, sanitizeToolName } from "@cloudflare/codemode";
import { RpcTarget } from "cloudflare:workers";
import { runCodemodeRouterInvocation } from "./codemodeRouterInvocation";

type SandboxToolFn = (...args: unknown[]) => Promise<unknown>;

export class EdgeClawToolDispatcher extends RpcTarget {
  readonly #fns: Record<string, SandboxToolFn>;
  readonly #positionalArgs: boolean;

  constructor(sanitizedFns: Record<string, SandboxToolFn>, positionalArgs = false) {
    super();
    this.#fns = sanitizedFns;
    this.#positionalArgs = positionalArgs;

    for (const name of Object.keys(sanitizedFns)) {
      if (this.#positionalArgs) {
        (this as EdgeClawToolDispatcher & Record<string, unknown>)[name] = (...args: unknown[]) =>
          this.#invokeDecoded(name, JSON.stringify(args));
      } else {
        (this as EdgeClawToolDispatcher & Record<string, unknown>)[name] = (maybeArg?: unknown) =>
          this.#invokeDecoded(name, JSON.stringify(maybeArg ?? {}));
      }
    }
  }

  /**
   * Wire-format JSON `{ result } | { error }` (`codemode` Proxy parses this internally).
   */
  async call(name: string, argsJson: string): Promise<string> {
    return this.#invokeWire(name, argsJson);
  }

  async #invokeDecoded(name: string, argsJson: string): Promise<unknown> {
    const wire = await this.#invokeWire(name, argsJson);
    const data = JSON.parse(wire) as { error?: unknown; result?: unknown };
    if (data.error != null) {
      throw new Error(String(data.error));
    }
    return data.result;
  }

  async #invokeWire(name: string, argsJson: string): Promise<string> {
    const fn = this.#fns[name];
    if (!fn) return JSON.stringify({ error: `Tool "${name}" not found` });
    try {
      if (this.#positionalArgs) {
        const args = argsJson ? JSON.parse(argsJson) : [];
        const result = await fn(...(Array.isArray(args) ? args : [args]));
        return JSON.stringify({ result });
      }
      const result = await fn(argsJson ? JSON.parse(argsJson) : {});
      return JSON.stringify({ result });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export interface EdgeClawDynamicWorkerExecutorOptions {
  loader: WorkerLoader;
  timeout?: number;
  globalOutbound?: Fetcher | null;
  modules?: Record<string, string>;
}

/**
 * Drop-in successor to {@link DynamicWorkerExecutor} that wires {@link EdgeClawToolDispatcher}.
 */
export class EdgeClawDynamicWorkerExecutor implements Executor {
  readonly #loader: WorkerLoader;
  readonly #timeout: number;
  readonly #globalOutbound: Fetcher | null | undefined;
  readonly #modules: Record<string, string>;

  constructor(options: EdgeClawDynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30_000;
    this.#globalOutbound = options.globalOutbound ?? null;
    const { ["executor.js"]: _ignored, ...safeModules } = options.modules ?? {};
    void _ignored;
    this.#modules = safeModules;
  }

  async execute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, SandboxToolFn>
  ): Promise<ExecuteResult> {
    return runCodemodeRouterInvocation(() => this.performExecute(code, providersOrFns));
  }

  private async performExecute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, SandboxToolFn>
  ): Promise<ExecuteResult> {
    let providers: ResolvedProvider[];
    if (!Array.isArray(providersOrFns)) {
      console.warn(
        "[EdgeClaw][codemode-executor] Deprecated: passing raw fn map — wrapping as `{ name: codemode }`."
      );
      providers = [{ name: "codemode", fns: providersOrFns }];
    } else {
      providers = providersOrFns;
    }

    const normalized = normalizeCode(code);
    const timeoutMs = this.#timeout;
    const RESERVED_NAMES = new Set(["__dispatchers", "__logs"]);
    const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const seenNames = new Set<string>();

    for (const provider of providers) {
      if (RESERVED_NAMES.has(provider.name)) {
        return { result: void 0, error: `Provider name "${provider.name}" is reserved` };
      }
      if (!VALID_IDENT.test(provider.name)) {
        return {
          result: void 0,
          error: `Provider name "${provider.name}" is not a valid JavaScript identifier`,
        };
      }
      if (seenNames.has(provider.name)) {
        return { result: void 0, error: `Duplicate provider name "${provider.name}"` };
      }
      seenNames.add(provider.name);
    }

    const executorModule = [
      `import { WorkerEntrypoint } from "cloudflare:workers";`,
      "",
      `export default class CodeExecutor extends WorkerEntrypoint {`,
      `  async evaluate(__dispatchers = {}) {`,
      `    const __logs = [];`,
      `    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };`,
      `    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };`,
      `    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };`,
      ...providers.map((p) => {
        if (p.positionalArgs) {
          return `    const ${p.name} = new Proxy({}, {\n      get: (_, toolName) => async (...args) => {\n        const resJson = await __dispatchers.${p.name}.call(String(toolName), JSON.stringify(args));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
        }
        return `    const ${p.name} = new Proxy({}, {\n      get: (_, toolName) => async (args) => {\n        const resJson = await __dispatchers.${p.name}.call(String(toolName), JSON.stringify(args ?? {}));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
      }),
      "",
      `    try {`,
      `      const result = await Promise.race([`,
      `        (`,
      `${normalized}`,
      `)(),`,
      `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
      `      ]);`,
      `      return { result, logs: __logs };`,
      `    } catch (err) {`,
      `      return { result: undefined, error: err.message, logs: __logs };`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n");

    const dispatchers: Record<string, EdgeClawToolDispatcher> = {};
    for (const provider of providers) {
      const sanitizedFns: Record<string, SandboxToolFn> = {};
      for (const [name, fn] of Object.entries(provider.fns)) {
        sanitizedFns[sanitizeToolName(name)] = fn as SandboxToolFn;
      }
      dispatchers[provider.name] = new EdgeClawToolDispatcher(
        sanitizedFns,
        Boolean(provider.positionalArgs)
      );
    }

    const loader = this.#loader as unknown as {
      get(name: string, init: () => Record<string, unknown>): {
        getEntrypoint(): { evaluate(dispatchersArg: Record<string, EdgeClawToolDispatcher>): Promise<unknown> };
      };
    };

    const responseUnknown = await loader
      .get(`codemode-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        ...this.#modules,
        "executor.js": executorModule,
      },
      globalOutbound: this.#globalOutbound,
    }))
      .getEntrypoint()
      .evaluate(dispatchers);

    const response = responseUnknown as {
      result?: unknown;
      error?: string;
      logs?: string[];
    };

    if (response.error)
      return { result: void 0, error: response.error, logs: response.logs };
    return {
      result: response.result,
      logs: response.logs,
    };
  }
}
