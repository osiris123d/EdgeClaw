# Promotion manifests: Cloudflare Artifacts adapter

## Current behavior

- `resolveArtifactPromotionWriter` (`src/promotion/artifactPromotionWriterFactory.ts`) chooses, in order:
  1. **Cloudflare Artifacts** — when `ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS` is truthy (`true` / `1` / `on`) **and** the `ARTIFACTS` Workers binding is present.
  2. Else **R2** — when `ENABLE_PROMOTION_ARTIFACTS_R2` is not `"false"` **and** `PROMOTION_ARTIFACTS_BUCKET` is bound.
  3. Else **noop** (digest-only).

- Only **MainAgent** orchestration paths call `resolveArtifactPromotionWriter` — sub-agents do not receive this binding.

## Configuration

1. Add an Artifacts binding in Wrangler (see commented block in `wrangler.jsonc`).
2. Set vars (or `vars` in Wrangler):
   - `ENABLE_PROMOTION_ARTIFACTS_CF_ARTIFACTS`: `"true"`
   - Optional: `PROMOTION_ARTIFACTS_REPO_NAME` (default `edgeclaw-promotion-manifests`).

## Mapping model

- One **dedicated Artifacts repository** holds immutable manifest JSON files.
- Paths match the existing R2 object key layout (`buildPromotionManifestR2ObjectKey`) so bundle identity and tooling stay aligned across backends.
- `PromotionArtifactRef.storageUri` uses `artifacts://<repoName>/<url-encoded-path>` for audit and verification.
- `storageBackend` is `"workers-artifacts"`; digests still come from `promotionManifestCanonical.ts`.

## Implementation notes

- Writes use **isomorphic-git** + in-memory FS (`artifactsMemoryFs.ts`) against the repo HTTPS remote and Artifacts tokens, per Cloudflare’s documented pattern.
- Each write may **clone + commit + push** (existing repo) or **init + push** (first commit). Reads clone shallowly to verify — acceptable for promotion-frequency workloads.

## Deferred / cutover follow-ups

- **Performance:** Replace per-operation clone with persistent caching, sparse checkout, or a future first-party blob API if Cloudflare adds one for Artifacts.
- **Empty-remote edge cases:** If a repo exists but has no commits yet (failed first push), a subsequent write may need recovery logic beyond the current try/create/get flow.
- **Wrangler / account:** Ensure Artifacts is enabled for the account and Wrangler supports the `artifacts` block (`npx wrangler types` after binding).
