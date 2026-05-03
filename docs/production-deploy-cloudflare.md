# Production deployment on Cloudflare (EdgeClaw Truth)

**Platform context:** [`coding-platform-architecture.md`](./coding-platform-architecture.md) (layers, factory precedence, migration).

## Separation from preview

- **Types:** `productionDeployTypes.ts` vs `previewDeployTypes.ts`.
- **Factories:** `resolveProductionDeployAdapter` vs `resolvePreviewDeployAdapter` — no shared adapter instances.
- **Workflows:** `EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW` vs preview promotion workflow.
- **Boundary:** Only **MainAgent** resolves adapters and runs `runProductionDeployment`; CoderAgent / TesterAgent / coding loop must not import production deploy modules.

## Policy (orchestrator)

`runProductionDeployment` runs **before** the backend:

- `requestedTier === "production"`
- Release gate **allow** and tier **production**
- At least **two** distinct `approverId` values (`PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS`)
- `artifactWritten`, bundle id alignment, manifest digest alignment vs `bundleRef.manifestDigest`

## What the verified backend does today

When durable promotion storage exists and `ENABLE_PRODUCTION_DEPLOY` is not `"false"`:

1. **`createPromotionArtifactVerifiedProductionDeployAdapter`** re-reads the manifest via `ArtifactPromotionWriter.readManifest(ref)` and compares canonical digests to the request manifest (same trust model as preview verification).

2. **URL fields:** `PRODUCTION_DEPLOY_PUBLIC_URL` if set; otherwise optional account subdomain API → `workers.dev` URL for `PRODUCTION_WORKER_SCRIPT_NAME` (informational — **not** proof that production traffic moved).

3. **Optional witness:** `ENABLE_PRODUCTION_DEPLOY_CF_WITNESS` + `CLOUDFLARE_ACCOUNT_ID` + **`CLOUDFLARE_API_TOKEN`** — GET **script-settings** for audit only.

4. **`rollbackHint`** on success explains that **no** Worker version upload or route flip occurred in this seam.

Prefer **`launchProductionDeployWorkflow`** for durable, retryable execution.

## Deferred: hardened enterprise rollout

- **Workers Versions** upload + **deployments** API (or Wrangler from CI) tied to the same `PromotionArtifactRef` / build artifact.
- **Separate production Worker** name or environment than preview; **custom hostnames** and **Gradual Rollouts** / **canary** semantics.
- Capture **`previousStableIdentifier`** from the API before rollout for automated rollback.
- **Secrets / SOX:** immutable audit sink, approval tickets enforced in adapter when `changeTicketId` required by policy.
- **Rate limits and idempotency** keys for production workflow steps.
