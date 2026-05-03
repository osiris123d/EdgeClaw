# Preview deployment on Cloudflare (EdgeClaw Truth)

**Platform context:** [`coding-platform-architecture.md`](./coding-platform-architecture.md) (layers, factory precedence, migration).

## What runs today (orchestrator-only)

Preview deploy stays **downstream** of promotion artifact write and release-gate **allow** (`runPreviewDeployment`, Workflow preview promotion pipeline). Sub-agents and the coding loop must **not** call preview deploy adapters (`previewDeployTypes.ts` boundary).

`resolvePreviewDeployAdapter` builds this chain (each layer optional except verification):

1. **noop** when verified preview is disabled (`ENABLE_PREVIEW_DEPLOY_R2=false`) or there is **no** durable promotion storage (`hasArtifactPromotionPersistence`).
2. **`createPromotionArtifactVerifiedPreviewDeployAdapter`** — re-reads the manifest via `resolveArtifactPromotionWriter(env)` (R2 or Cloudflare Artifacts). **PromotionArtifactRef** + digest are the trust boundary.
3. **Optional Workers Versions upload** (`ENABLE_PREVIEW_WORKER_VERSION_UPLOAD=true` + `PREVIEW_WORKER_UPLOAD_SCRIPT_NAME` + `CLOUDFLARE_ACCOUNT_ID` + **`CLOUDFLARE_API_TOKEN`**) — multipart POST to the Workers **Versions** API for a **separate preview Worker script** (see below). Runs **after** verification and **before** the optional witness.
4. **Optional script-settings witness** (`ENABLE_PREVIEW_DEPLOY_CF_WITNESS=true` + account id + token) — GET Workers **script-settings** for tags/API audit; does **not** upload traffic.

**URL reporting:** canonical `PREVIEW_DEPLOY_PUBLIC_URL`, else Workers account subdomain lookup → default `workers.dev` URL for `PREVIEW_WORKER_SCRIPT_NAME`. When the Versions upload succeeds, `previewUrl` prefers any preview URL returned by the upload response (or scanned from JSON); `previewIdentifier` is set to the **Workers API version id** (`result.id`).

### Structured results (`PreviewDeployResult`)

| Field | Meaning |
| --- | --- |
| `status` | `succeeded` \| `blocked` \| `failed` |
| `previewUrl` | Human URL when succeeded (may come from upload response or verified path) |
| `previewIdentifier` | Opaque id — version id when upload runs; otherwise adapter-specific |
| `audit` | Immutable row — includes `adapterBackend` chain, optional `workersApiVersionId`, `workersVersionHasPreview`, witness fields |
| `failureCategory` | On failure: `precheck_failed` \| `adapter_error` \| `policy_blocked` |

## Separate preview Worker (required for real uploads)

The production Worker (`wrangler.jsonc` `name`, e.g. `edgeclaw-truth-agent`) uses **Durable Objects**. Cloudflare does **not** expose version preview URLs for DO-backed Workers in the same way as plain Workers. Therefore **real preview uploads target a second script** — a minimal **stub Worker** with **no DO bindings**, created once in the dashboard or via Wrangler (`PREVIEW_WORKER_UPLOAD_SCRIPT_NAME`).

The stub script receives promotion metadata as **plain_text** bindings (`MANIFEST_DIGEST`, `BUNDLE_ID`) and returns JSON — enough for audit and smoke checks. It is **not** a byte-identical deploy of the production bundle; production rollout remains Wrangler/CI and the separate production deploy seam.

### Operator checklist

1. Create a **new** Workers script in the same account (name matches `PREVIEW_WORKER_UPLOAD_SCRIPT_NAME`).
2. Ensure it has **no** Durable Object namespaces if you need Workers-generated preview URLs where available.
3. Grant `CLOUDFLARE_API_TOKEN` **Workers Scripts: Edit** (and account read as needed for APIs you use).
4. Set `PREVIEW_WORKER_UPLOAD_COMPATIBILITY_DATE` if your account requires a specific `compatibility_date` (defaults match `wrangler.jsonc`).

### Fallback path

If version upload is **disabled**, **misconfigured** (missing script name or token), or **fails** after verification succeeded, behavior is:

- **Disabled / not wired:** Only promotion-verified + optional witness run — same as before upload existed.
- **Upload fails:** Result is `failed` with `failureCategory: adapter_error`, `audit.adapterBackend` suffix `+cf_workers_version_upload_failed`, and inner `previewUrl` / `previewIdentifier` preserved for debugging.

Use `buildPromotionPlatformDiagnostics(env)` / `formatPromotionPlatformDiagnosticsReport` to see whether `workers_version_upload` would apply (`workersVersionUploadWrapped`) without calling the network.

## Related

- [`operator-live-readiness-checklist.md`](./operator-live-readiness-checklist.md) — validation commands and staging notes.
