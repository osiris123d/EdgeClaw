/**
 * Environment bindings and configuration for the agent
 * Defines the shape of all external services, KV stores, and resources
 */

// Browser binding for web navigation and rendering
export interface BrowserBindings {
  /** Cloudflare Browser Rendering binding. Required for browser_search / browser_execute tools. */
  BROWSER?: Fetcher;
  /** WorkerLoader binding for sandboxed code execution (browser_execute). */
  LOADER?: WorkerLoader;
}

// AI and model services
/** Minimal shape for the Workers `ai` binding (aligns with @cloudflare/voice `AiLike`). */
export type WorkersAiBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
};

export interface AIBindings {
  AI?: WorkersAiBinding;
}

// Persistent storage bindings
export interface StorageBindings {
  KV_MEMORY?: KVNamespace; // Optional supplemental KV store
  CACHE?: CacheStorage; // Optional cache binding for app-level response caching
  /**
   * Optional KV binding used **only** by `createSharedWorkspaceKvStorage` — one implementation of
   * `SharedWorkspaceStorage`. Not the conceptual architecture (see `src/workspace/sharedWorkspaceTypes.ts`).
   */
  SHARED_WORKSPACE_KV?: KVNamespace;
  /**
   * Optional KV for Sub-Agents / coordinator control-plane (projects, tasks, recorded runs).
   * See `src/coordinatorControlPlane/` and `/api/coordinator/*` routes.
   */
  COORDINATOR_CONTROL_PLANE_KV?: KVNamespace;
}

// R2 bucket bindings
export interface R2Bindings {
  /**
   * R2 bucket used by the session-skills SkillProvider.
   * Required when ENABLE_SKILLS=true; absent in deployments that don't use skills.
   * Bind in wrangler.jsonc:  { "r2_buckets": [{ "binding": "SKILLS_BUCKET", "bucket_name": "..." }] }
   */
  SKILLS_BUCKET?: R2Bucket;
  /**
   * Immutable promotion bundle manifests (`ArtifactPromotionWriter` R2 adapter).
   * Separate from SKILLS_BUCKET and collaboration KV — create via `wrangler r2 bucket create …`.
   */
  PROMOTION_ARTIFACTS_BUCKET?: R2Bucket;
}

// Static assets binding (for serving frontend from Workers)
export interface StaticAssetBindings {
  ASSETS?: Fetcher;
}

// Durable Object namespace bindings
export interface DurableObjectBindings {
  /** DO namespace for MainAgent instances. Used by `getAgentByName` and `routeAgentRequest`. */
  MAIN_AGENT: DurableObjectNamespace<any>;
  /** Isolated Agent→Agent sub-agent repro (`src/repro/subagentAgentReproDo.ts`). */
  REPRO_SUBAGENT_AGENT?: DurableObjectNamespace<any>;
  /** Isolated Think→Think `child.chat` repro (`src/repro/subagentThinkReproDo.ts`). */
  REPRO_SUBAGENT_THINK?: DurableObjectNamespace<any>;
  /**
   * Optional Think parent that runs coder/tester `subAgent` delegation off MainAgent (`stub.fetch` + JSON).
   * When bound, MainAgent routes `runCodingCollaborationLoop` / `delegateToCoder` / `delegateToTester` here.
   */
  SUBAGENT_COORDINATOR?: DurableObjectNamespace<any>;
}

// Cloudflare Flagship (optional release-gate evaluation via Workers binding — see `flagshipEvaluationAdapterFactory`)
export interface FlagshipBindings {
  /**
   * Feature-flag binding from Wrangler `flagship` config — commonly named `FLAGS`
   * (@see https://developers.cloudflare.com/flagship/binding/).
   */
  FLAGS?: Flagship;
}

// Cloudflare Artifacts (optional git-backed promotion manifests — see `artifactPromotionWriterFactory`)
export interface ArtifactsBindings {
  /** When bound + opt-in flag, `resolveArtifactPromotionWriter` may store manifests via native Artifacts git remotes. */
  ARTIFACTS?: Artifacts;
}

// Cloudflare Workflows bindings
// Add one entry per workflow class registered in wrangler.jsonc.
// The key must exactly match the "binding" value in the wrangler.jsonc workflows array.
export interface WorkflowBindings {
  /** Durable research workflow — binding for EdgeclawResearchWorkflow. */
  EDGECLAW_RESEARCH_WORKFLOW?: Workflow;
  /**
   * Page intelligence workflow — Browser Rendering + Workers AI + R2.
   * Binding for EdgeclawPageIntelWorkflow.
   */
  EDGECLAW_PAGE_INTEL_WORKFLOW?: Workflow;
  /** Preview promotion pipeline — `EdgeclawPreviewPromotionWorkflow`. */
  EDGECLAW_PREVIEW_PROMOTION_WORKFLOW?: Workflow;
  /** Production-only deploy — `EdgeclawProductionDeployWorkflow`. */
  EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW?: Workflow;
}

// Environment variables
export interface Variables {
  ENVIRONMENT?: "production" | "staging" | "development";
  APP_NAME?: string;
  AI_GATEWAY_BASE_URL?: string;
  // Backward-compatible alias; prefer AI_GATEWAY_BASE_URL.
  AI_GATEWAY_URL?: string;
  ENABLE_BROWSER_TOOLS?: string;
  ENABLE_BROWSER_TOOL_DEBUG?: string;
  ENABLE_CODE_EXECUTION?: string;
  ENABLE_MCP?: string;
  ENABLE_VOICE?: string;
  /** Set to "true" to enable the session-skills feature (requires SKILLS_BUCKET R2 binding). */
  ENABLE_SKILLS?: string;
  /** Set to "false" to disable repo_git_* tools (default on; live git still needs a GitExecutionAdapter). */
  ENABLE_GIT_INTEGRATION_TOOLS?: string;
  /**
   * When "true", prefer Cloudflare Artifacts (`ARTIFACTS` binding) for promotion manifests when bound.
   * Falls back to R2 when unset/disabled or when `ARTIFACTS` is missing.
   */
  ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS?: string;
  /** Repo name within the Artifacts namespace for immutable promotion JSON (default `edgeclaw-promotion-manifests`). */
  PROMOTION_ARTIFACTS_REPO_NAME?: string;
  /**
   * When "false", force noop artifact writer even if PROMOTION_ARTIFACTS_BUCKET is bound.
   */
  ENABLE_PROMOTION_ARTIFACTS_R2?: string;
  /** Must match wrangler `bucket_name` for PROMOTION_ARTIFACTS_BUCKET — used in PromotionArtifactRef.storageUri. */
  PROMOTION_ARTIFACTS_BUCKET_NAME?: string;
  /**
   * When "false", disable verified preview deploy (noop adapter). Legacy name (`…_R2`); verified deploy uses Artifacts or R2 when promotion persistence exists.
   * COMPATIBILITY: name suggests R2-only; actually gates **all** verified preview. TODO(deprecation): alias `ENABLE_PREVIEW_DEPLOY_VERIFIED` in a future breaking release only.
   * @see `resolvePreviewDeployAdapter` in `src/deploy/previewDeployAdapterFactory.ts`
   */
  ENABLE_PREVIEW_DEPLOY_R2?: string;
  /**
   * When "true", after manifest verification call Cloudflare Workers **script-settings** API as an audit witness (requires `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`).
   */
  ENABLE_PREVIEW_DEPLOY_CF_WITNESS?: string;
  /**
   * Optional canonical URL returned as `PreviewDeployResult.previewUrl` (skips workers.dev API lookup).
   * Use a dedicated preview hostname or routes URL when not using default workers.dev resolution.
   */
  PREVIEW_DEPLOY_PUBLIC_URL?: string;
  /** Wrangler `name` / Workers script name for default workers.dev URL construction. */
  PREVIEW_WORKER_SCRIPT_NAME?: string;
  /**
   * When `"true"`, after manifest verification upload a stub Worker **version** via Workers Versions API to a **separate**
   * preview script (`PREVIEW_WORKER_UPLOAD_SCRIPT_NAME`). Requires `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` with Workers Scripts Edit.
   * Does not upload the production DO-backed Worker binary — see `docs/preview-deploy-cloudflare.md`.
   */
  ENABLE_PREVIEW_WORKER_VERSION_UPLOAD?: string;
  /** Workers script **name** (dashboard name) that receives stub preview uploads — must be DO-free for version preview URLs. */
  PREVIEW_WORKER_UPLOAD_SCRIPT_NAME?: string;
  /** Optional `compatibility_date` passed in upload metadata (default aligns with wrangler `compatibility_date`). */
  PREVIEW_WORKER_UPLOAD_COMPATIBILITY_DATE?: string;
  /**
   * HTTPS endpoint that accepts POST JSON `FlagshipEvaluationContext` and returns a `ReleaseGateDecision` body.
   * When unset, `resolveFlagshipEvaluationAdapter` uses the noop adapter.
   */
  FLAGSHIP_EVALUATION_URL?: string;
  /**
   * Bearer token for `FLAGSHIP_EVALUATION_URL` (`Authorization: Bearer …`). Prefer Workers secrets in production.
   */
  FLAGSHIP_EVALUATION_AUTH_TOKEN?: string;
  /**
   * When `"false"`, skip HTTP Flagship adapter even if `FLAGSHIP_EVALUATION_URL` is set (binding adapter still used when enabled).
   */
  ENABLE_FLAGSHIP_HTTP?: string;
  /**
   * When `"true"`, prefer Cloudflare Flagship Workers binding (`FLAGS`) for release gate evaluation when bound.
   */
  ENABLE_FLAGSHIP_BINDING?: string;
  /** String flag key whose value is `allow` | `deny` | `hold` (default `edgeclaw-release-gate`). */
  FLAGSHIP_RELEASE_GATE_FLAG_KEY?: string;
  /** Optional HTTP client timeout in milliseconds for Flagship POST (default 15000). */
  FLAGSHIP_HTTP_TIMEOUT_MS?: string;
  /** When `"false"`, production deploy adapter stays noop-only (`productionDeployAdapterFactory.ts`). Otherwise uses promotion-verified backend when durable promotion storage exists. */
  ENABLE_PRODUCTION_DEPLOY?: string;
  /**
   * When `"true"`, after manifest verification call Cloudflare Workers **script-settings** API as an audit witness on the **production** deploy path (requires `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`).
   */
  ENABLE_PRODUCTION_DEPLOY_CF_WITNESS?: string;
  /**
   * Optional canonical URL used as `ProductionDeployResult.productionDeploymentUrl` (skips workers.dev subdomain lookup).
   */
  PRODUCTION_DEPLOY_PUBLIC_URL?: string;
  /** Workers script name for workers.dev URL construction when no canonical production URL is set. */
  PRODUCTION_WORKER_SCRIPT_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /**
   * AI Gateway id slug (same segment as in `AI_GATEWAY_BASE_URL` …/v1/{account}/{gateway}/…).
   * Optional when the gateway id can be parsed from the compat base URL; used by the AI Gateway logs proxy.
   */
  AI_GATEWAY_ID?: string;
  /**
   * Controls how much routing and turn telemetry is emitted.
   * Accepted values: `"off"` | `"error"` | `"info"` (default) | `"debug"`
   * Unset or unrecognised values default to `"info"`.
   * Set to `"off"` in production to silence all observability output.
   */
  OBSERVABILITY_LEVEL?: string;
  /**
   * Bearer secret for `GET /api/ops/staging-report` — promotion staging JSON on deployed Workers.
   * Prefer Workers secrets; omit locally unless testing the route.
   */
  STAGING_OPS_TOKEN?: string;
  /**
   * When `"true"`, enables `GET|POST /api/debug/orchestrate` (Worker) → MainAgent real coding loop over
   * the dedicated debug shared project id (`src/debug/orchestrationDebugProjectId.ts`). Off by default.
   */
  ENABLE_DEBUG_ORCHESTRATION_ENDPOINT?: string;
  /**
   * Optional shared secret: when set, require `Authorization: Bearer <token>` on the debug orchestrate route.
   * Prefer Workers secrets (top-level `DEBUG_ORCHESTRATION_TOKEN`) in deployed environments.
   */
  DEBUG_ORCHESTRATION_TOKEN?: string;
  /**
   * When `"true"`, enables `GET /api/repro/subagent/agent-ping` and `GET /api/repro/subagent/think-chat`
   * (isolated repro DOs — see `src/repro/`). Off by default.
   */
  ENABLE_SUBAGENT_REPRO_ENDPOINT?: string;
  /**
   * Optional Bearer for repro routes when set (same pattern as `DEBUG_ORCHESTRATION_TOKEN`).
   */
  SUBAGENT_REPRO_TOKEN?: string;
}

/**
 * Complete environment type for the Worker
 * @example
 * export default {
 *   fetch: (request: Request, env: Env) => handleRequest(request, env)
 * }
 */
export interface Env
  extends BrowserBindings,
    AIBindings,
    StorageBindings,
    R2Bindings,
    StaticAssetBindings,
    DurableObjectBindings,
    WorkflowBindings,
    ArtifactsBindings,
    FlagshipBindings {
  Variables?: Variables;
  ENVIRONMENT?: "production" | "staging" | "development";
  APP_NAME?: string;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_URL?: string;
  ENABLE_BROWSER_TOOLS?: string;
  ENABLE_BROWSER_TOOL_DEBUG?: string;
  ENABLE_CODE_EXECUTION?: string;
  ENABLE_MCP?: string;
  ENABLE_VOICE?: string;
  ENABLE_SKILLS?: string;
  ENABLE_GIT_INTEGRATION_TOOLS?: string;
  ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS?: string;
  PROMOTION_ARTIFACTS_REPO_NAME?: string;
  ENABLE_PROMOTION_ARTIFACTS_R2?: string;
  PROMOTION_ARTIFACTS_BUCKET_NAME?: string;
  ENABLE_PREVIEW_DEPLOY_R2?: string;
  ENABLE_PREVIEW_DEPLOY_CF_WITNESS?: string;
  PREVIEW_DEPLOY_PUBLIC_URL?: string;
  PREVIEW_WORKER_SCRIPT_NAME?: string;
  ENABLE_PREVIEW_WORKER_VERSION_UPLOAD?: string;
  PREVIEW_WORKER_UPLOAD_SCRIPT_NAME?: string;
  PREVIEW_WORKER_UPLOAD_COMPATIBILITY_DATE?: string;
  FLAGSHIP_EVALUATION_URL?: string;
  FLAGSHIP_EVALUATION_AUTH_TOKEN?: string;
  ENABLE_FLAGSHIP_HTTP?: string;
  ENABLE_FLAGSHIP_BINDING?: string;
  FLAGSHIP_RELEASE_GATE_FLAG_KEY?: string;
  FLAGSHIP_HTTP_TIMEOUT_MS?: string;
  ENABLE_PRODUCTION_DEPLOY?: string;
  ENABLE_PRODUCTION_DEPLOY_CF_WITNESS?: string;
  PRODUCTION_DEPLOY_PUBLIC_URL?: string;
  PRODUCTION_WORKER_SCRIPT_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /**
   * AI Gateway id slug (same segment as in `AI_GATEWAY_BASE_URL` …/v1/{account}/{gateway}/…).
   * Optional when the gateway id can be parsed from `AI_GATEWAY_BASE_URL`; required for List Logs when the URL is non-standard.
   */
  AI_GATEWAY_ID?: string;
  OBSERVABILITY_LEVEL?: string;
  STAGING_OPS_TOKEN?: string;
  ENABLE_DEBUG_ORCHESTRATION_ENDPOINT?: string;
  DEBUG_ORCHESTRATION_TOKEN?: string;
  ENABLE_SUBAGENT_REPRO_ENDPOINT?: string;
  SUBAGENT_REPRO_TOKEN?: string;
  // Secrets are injected as top-level env fields in Workers.
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  CLOUDFLARE_BROWSER_API_TOKEN?: string;
  MCP_SERVER_URL?: string;
  MCP_AUTH_TOKEN?: string;
}

/**
 * Type-safe environment accessor with validation.
 * Throws for bindings that are always required; logs warnings for optional ones.
 */
export function validateEnvironment(env: unknown): asserts env is Env {
  const e = env as Record<string, unknown>;

  if (!e.MAIN_AGENT) {
    throw new Error("Missing Durable Object binding: MAIN_AGENT");
  }

  // SKILLS_BUCKET is optional — only needed when ENABLE_SKILLS=true.
  // Warn here so misconfigured deployments surface early without hard-failing.
  if (!e.SKILLS_BUCKET) {
    console.warn(
      "[env] SKILLS_BUCKET R2 binding not found. " +
        "Session skills will be unavailable. " +
        "Add an r2_buckets binding named SKILLS_BUCKET in wrangler.jsonc to enable."
    );
  }
}

/**
 * Returns true when the SKILLS_BUCKET R2 binding is present at runtime.
 * Use this as a guard before constructing R2SkillProvider:
 *   if (hasSkillsBucket(env)) { ... }
 */
export function hasSkillsBucket(env: Env): env is Env & Required<R2Bindings> {
  return env.SKILLS_BUCKET != null;
}

export interface RuntimeFeatureFlags {
  enableBrowserTools: boolean;
  enableBrowserToolDebug: boolean;
  enableCodeExecution: boolean;
  enableMcp: boolean;
  enableVoice: boolean;
  /** True when ENABLE_SKILLS=true AND SKILLS_BUCKET binding is present. */
  enableSkills: boolean;
}

export interface RuntimeConfig {
  environment: "production" | "staging" | "development";
  appName: string;
  aiGatewayBaseUrl: string;
  observabilityLevel?: string;
  featureFlags: RuntimeFeatureFlags;
}

function parseBooleanFlag(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getVar(env: Env, key: keyof Variables): string | undefined {
  const nested = env.Variables?.[key];
  if (typeof nested === "string") return nested;

  const topLevel = env[key as keyof Env];
  return typeof topLevel === "string" ? topLevel : undefined;
}

export function getRuntimeConfig(env: Env): RuntimeConfig {
  validateEnvironment(env);

  const environment = (getVar(env, "ENVIRONMENT") as RuntimeConfig["environment"] | undefined) ?? "development";
  const aiGatewayBaseUrl = getVar(env, "AI_GATEWAY_BASE_URL") ?? getVar(env, "AI_GATEWAY_URL");

  if (!aiGatewayBaseUrl || aiGatewayBaseUrl.trim() === "") {
    throw new Error(
      "Missing required variable: AI_GATEWAY_BASE_URL (or legacy AI_GATEWAY_URL)."
    );
  }

  const normalizedGatewayBaseUrl = aiGatewayBaseUrl.trim().replace(/\/+$/, "");
  if (!/\/compat$/i.test(normalizedGatewayBaseUrl)) {
    throw new Error(
      `AI_GATEWAY_BASE_URL must point to the OpenAI-compatible /compat endpoint (got: ${aiGatewayBaseUrl}).`
    );
  }

  return {
    environment,
    appName: getVar(env, "APP_NAME")?.trim() || "EdgeClaw",
    aiGatewayBaseUrl: normalizedGatewayBaseUrl,
    observabilityLevel: getVar(env, "OBSERVABILITY_LEVEL"),
    featureFlags: {
      enableBrowserTools: parseBooleanFlag(getVar(env, "ENABLE_BROWSER_TOOLS"), false),
      enableBrowserToolDebug: parseBooleanFlag(getVar(env, "ENABLE_BROWSER_TOOL_DEBUG"), false),
      enableCodeExecution: parseBooleanFlag(getVar(env, "ENABLE_CODE_EXECUTION"), false),
      enableMcp: parseBooleanFlag(getVar(env, "ENABLE_MCP"), false),
      enableVoice: parseBooleanFlag(getVar(env, "ENABLE_VOICE"), false),
      // Skills require both the feature flag AND the R2 bucket binding.
      enableSkills:
        parseBooleanFlag(getVar(env, "ENABLE_SKILLS"), false) &&
        hasSkillsBucket(env),
    },
  };
}
