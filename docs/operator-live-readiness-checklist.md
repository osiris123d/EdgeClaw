# Operator live-readiness checklist — promotion, Flagship, preview & production deploy

This checklist lists **bindings**, **Wrangler config**, **environment variables**, and **Cloudflare account prerequisites** for the promotion platform. Factory precedence is summarized in [`coding-platform-architecture.md`](./coding-platform-architecture.md).

**Diagnostics (read-only, no secrets in output):**

- `npm run diagnose:platform` — prints branches for an **empty** env (all noop / fallback).
- `npm run diagnose:staging` — same plus **noop aggregation** lines and a JSON sample from `runStagingPromotionSmoke` (`src/promotion/promotionOperationalStaging.ts`).
- In Worker code or tests: `formatPromotionPlatformDiagnosticsReport(env)` from `src/promotion/promotionPlatformDiagnostics.ts`.

### Deployed Worker: staging report (optional)

When **`STAGING_OPS_TOKEN`** is set (prefer Workers secrets):

- **`GET /api/ops/staging-report`** with header **`Authorization: Bearer <STAGING_OPS_TOKEN>`** returns JSON from **`runStagingPromotionSmoke(env)`**: active adapter branches, workflow binding presence, noop/fallback flags, and a **safe prepare probe** (empty patch ids — expects fast validation failure when `SHARED_WORKSPACE_KV` is bound).

This route does **not** run artifact write, release gate, or preview deploy — those require real approved patches (use preview promotion workflow or `runApprovedPatchesPreviewPipeline` after staging passes).

---

## Recommended defaults for **new** environments

Use this as the steady-state target when bindings and account features are available. Existing deployments may stay on **compatibility** paths (R2 manifests, HTTP Flagship) indefinitely.

| Area | Enable | Avoid unless needed |
|------|--------|---------------------|
| **Promotion manifests** | `ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS=true` + Wrangler **`artifacts`** binding | R2-only bucket (`PROMOTION_ARTIFACTS_BUCKET`) — valid **compatibility** path |
| **Release gate** | `ENABLE_FLAGSHIP_BINDING=true` + **`flagship`** / `FLAGS` binding | HTTP-only (`FLAGSHIP_EVALUATION_URL`) — use for external policy or migration |
| **Preview deploy** | Leave **`ENABLE_PREVIEW_DEPLOY_R2` unset** or any value except `"false"` when you want verified preview with persistence; add optional **`ENABLE_PREVIEW_WORKER_VERSION_UPLOAD`** + stub script for real preview uploads | Setting verified preview kill switch to `"false"` unless intentionally disabling preview deploy |
| **Production deploy** | `ENABLE_PRODUCTION_DEPLOY` not `"false"` when persistence exists | Accidental noop in prod |
| **Preview promotion execution** | **`EdgeclawPreviewPromotionWorkflow`** for user-facing / long-running flows | Sync pipeline alone for production durability expectations |
| **Secrets** | `CLOUDFLARE_API_TOKEN`, policy tokens in Workers secrets | Tokens in committed `vars` |
| **Sub-agent coordinator** | `SUBAGENT_COORDINATOR` binding + `SubagentCoordinatorThink` DO + migration **`v6-subagent-coordinator`** in `wrangler.jsonc` | Omit binding only when you intentionally want **legacy** MainAgent → `subAgent(Coder|Tester)` (same Worker, compatibility path) |
| **Sub-Agents control-plane KV** (optional) | `COORDINATOR_CONTROL_PLANE_KV` for `/api/coordinator/*` registry + run log | Omit if you only need health + debug probes without persisted projects/tasks |

Canonical precedence and migration steps: [`coding-platform-architecture.md`](./coding-platform-architecture.md).

---

## 1. Native Cloudflare Artifacts (promotion manifests)

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **Wrangler `artifacts` binding** | Uncomment/configure `artifacts` block in `wrangler.jsonc`; binding name must match code (`ARTIFACTS`). | Same; deploy Worker so binding resolves. |
| **`ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS`** | `"true"` in `vars` (or env). | Same; align across environments. |
| **`PROMOTION_ARTIFACTS_REPO_NAME`** | Optional; default `edgeclaw-promotion-manifests` if unset. | Set explicitly if you use a dedicated repo name. |
| **Account / dashboard** | Workers Artifacts enabled for the account; namespace from Wrangler. **Manual:** create/configure repo remote per Cloudflare Artifacts docs if required. | Same; validate git remote connectivity from Workers runtime after deploy. |

**Precedence:** Artifacts writer runs only when flag is **on** **and** `env.ARTIFACTS` is bound. Otherwise falls through to R2 or noop.

---

## 2. Flagship **binding** adapter (release gate)

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **`flagship` block in `wrangler.jsonc`** | Uncomment `flagship` with `binding` (typically `FLAGS`) and valid **app_id**. | Same; **manual:** create/configure Flagship app in dashboard; align **string flag** for allow/deny/hold. |
| **`ENABLE_FLAGSHIP_BINDING`** | `"true"`. | `"true"`. |
| **`FLAGSHIP_RELEASE_GATE_FLAG_KEY`** | Match your Flagship string flag (default `edgeclaw-release-gate`). | Same across envs for comparable behavior. |

**Fallback:** If binding branch not taken → HTTP adapter when `FLAGSHIP_EVALUATION_URL` set and `ENABLE_FLAGSHIP_HTTP` not `"false"` → else noop.

---

## 3. Flagship **HTTP** adapter (optional)

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **`FLAGSHIP_EVALUATION_URL`** | HTTPS endpoint returning release decision JSON. | Production URL + TLS. |
| **`FLAGSHIP_EVALUATION_AUTH_TOKEN`** | Prefer `.dev.vars` / Wrangler secrets (not committed). | Workers secret in prod. |
| **`ENABLE_FLAGSHIP_HTTP`** | Omit or `"true"` to allow HTTP path when binding unused. Set `"false"` to force noop when binding absent. | Lock down per policy. |
| **`FLAGSHIP_HTTP_TIMEOUT_MS`** | Optional. | Tune for prod latency. |

---

## 4. Preview deploy path (verified adapter)

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **Durable promotion storage** | `hasArtifactPromotionPersistence`: Artifacts path **or** `PROMOTION_ARTIFACTS_BUCKET` R2 binding (and `ENABLE_PROMOTION_ARTIFACTS_R2` not `"false"`). | Same; **manual:** create R2 bucket if using R2. |
| **`ENABLE_PREVIEW_DEPLOY_R2`** | Must **not** be `"false"` for verified preview (legacy kill switch name). | Same. |
| **`PREVIEW_DEPLOY_PUBLIC_URL`** | Optional canonical preview URL. | Set for stable reporting. |
| **`PREVIEW_WORKER_SCRIPT_NAME`** | Optional; default `edgeclaw-truth-agent`. | Align with Workers script name if using subdomain URL resolution. |
| **`CLOUDFLARE_ACCOUNT_ID`** + **`CLOUDFLARE_API_TOKEN`** | Optional; used for workers.dev subdomain lookup when no canonical URL. Token needs Workers read permissions; store as secret in prod. | Restrict token scope (least privilege). |
| **`ENABLE_PREVIEW_DEPLOY_CF_WITNESS`** | `"true"` only if script-settings witness desired; requires account id + API token. | Same. |

**Fallback:** noop preview adapter when kill switch or no promotion persistence.

---

## 5. Workflow-backed **preview promotion** pipeline

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **`workflows` entry** | `edgeclaw-preview-promotion-workflow` → `EDGECLAW_PREVIEW_PROMOTION_WORKFLOW` in `wrangler.jsonc`. | Same; **manual:** Workflows UI / account enablement if required. |
| **`src/lib/env.ts`** | Workflow binding typed on `Env`. | Deploy includes workflow registration. |
| **Orchestrator RPC** | Workflow calls MainAgent methods on DO stub (`executePreviewDeployment`, etc.). | Verify DO routing and workflow credentials in dashboard. |

Diagnostics report shows `EDGECLAW_PREVIEW_PROMOTION_WORKFLOW: true/false` when binding present.

---

## 6. Production deploy seam

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **`ENABLE_PRODUCTION_DEPLOY`** | Must **not** be `"false"` for verified production adapter when persistence exists. | Use kill switch deliberately in prod if needed. |
| **`PRODUCTION_DEPLOY_PUBLIC_URL`** / **`PRODUCTION_WORKER_SCRIPT_NAME`** | Same pattern as preview (production-oriented URLs). | Set canonical prod hostname expectations explicitly. |
| **`ENABLE_PRODUCTION_DEPLOY_CF_WITNESS`** | Optional; requires `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`. | Same. |

**Fallback:** noop when kill switch or no promotion persistence.

---

## 7. Workflow-backed **production deploy**

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **`workflows` entry** | `edgeclaw-production-deploy-workflow` → `EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW`. | Same; dashboard prerequisites as above. |

---

## 8. Sub-agent coordinator (canonical CoderAgent / TesterAgent path)

When **`SUBAGENT_COORDINATOR`** is bound, production coding delegation uses **MainAgent → coordinator DO → child** (`stub.fetch` + JSON). MainAgent keeps MCP, browser, voice, and user chat; the coordinator only orchestrates coder/tester. See [`coding-platform-architecture.md`](./coding-platform-architecture.md) (sub-agent orchestration) and [`agent-orchestration-boundaries.md`](./agent-orchestration-boundaries.md).

| Requirement | Local / dev | Staging / prod |
|-------------|-------------|----------------|
| **Wrangler `durable_objects.bindings`** | Entry `SUBAGENT_COORDINATOR` → class **`SubagentCoordinatorThink`** (match `src/server.ts` export). | Same on every Worker that should use the canonical path. |
| **Migration** | Tag **`v6-subagent-coordinator`** adds `SubagentCoordinatorThink` to `new_sqlite_classes`. | Deploy applies migration once per account/script; do not drop the class from config after cutover. |
| **`src/lib/env.ts`** | `SUBAGENT_COORDINATOR` optional on `Env`. | Deploy includes binding resolution in dashboard. |
| **`COORDINATOR_CONTROL_PLANE_KV`** (optional) | KV for Sub-Agents UI — `/api/coordinator/*` projects, tasks, run log (`coord_cp_v1_state`). | Create namespace; bind in `wrangler.jsonc` (see comment in `kv_namespaces`). |

**Fallback:** If **`SUBAGENT_COORDINATOR`** is absent, MainAgent uses **`subAgent(CoderAgent|TesterAgent)`** directly — supported for migration and dev sandboxes. The control-plane KV is independent (UI persistence only).

**Smoke (optional, gated):** `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT` + debug token — `GET|POST /api/debug/coordinator-chain`, or ChatPage **HTTP orchestrate** / **HTTP: fail_revise** (not the product contract; validates coordinator + revision loop).

---

## Validation phases

### Local / dev validation

1. Run `npm run diagnose:platform` — baseline noop branches.
2. Run `npm run test:promotion-integration` and `npm run test:preview-deploy-integration`.
3. `wrangler dev` with real `wrangler.jsonc` bindings; call `formatPromotionPlatformDiagnosticsReport(env)` from a temporary route or log in `server.ts` **only if needed** (remove before merge).
4. Confirm `buildPromotionPlatformDiagnostics(env)` shows expected `artifactPromotionWriter`, `flagshipEvaluation`, `previewDeploy`, `productionDeploy` branches.

### Staging validation

1. Deploy Worker + secrets (`npm run secrets` / dashboard).
2. Verify R2 bucket / Artifacts binding live in dashboard.
3. Run one preview promotion workflow smoke (manual trigger from UI or API).
4. Compare diagnostics report before/after toggling flags.

### Production prerequisites

1. **Manual (dashboard):** Flagship app + flags; R2 buckets; Artifacts namespace; API tokens with minimal scope; Workflows enabled.
2. Secrets: `CLOUDFLARE_API_TOKEN`, `FLAGSHIP_EVALUATION_AUTH_TOKEN`, AI keys — never in committed `vars`.
3. Change management: production deploy still requires **two distinct approvers** and orchestrator policy (`productionDeployPolicy.ts`) — not validated by diagnostics alone.

---

## What diagnostics **cannot** verify (manual)

- Correct **Flagship flag string values** (allow/deny/hold) in dashboard.
- **Workers Versions** preview upload: separate **stub** Worker script (`PREVIEW_WORKER_UPLOAD_SCRIPT_NAME`), token scopes, and DO vs non-DO behavior — see [`preview-deploy-cloudflare.md`](./preview-deploy-cloudflare.md). Verified adapters still apply when upload is off or fails.
- **Git remote** health for Artifacts (`isomorphic-git` network from Worker).
- **Workflow definition rows** in Workflows UI (`wf_definitions`) matching bindings.

---

## Related docs

- [`coding-platform-architecture.md`](./coding-platform-architecture.md)
- [`preview-deploy-cloudflare.md`](./preview-deploy-cloudflare.md)
- [`production-deploy-cloudflare.md`](./production-deploy-cloudflare.md)
