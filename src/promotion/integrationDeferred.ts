/**
 * Deferred integration map — **no runtime behavior** here.
 *
 * **Canonical precedence, layers, migration checklist, and capability matrix:**
 * `docs/coding-platform-architecture.md`
 *
 * **Live readiness / bindings / env vars:** `docs/operator-live-readiness-checklist.md` — diagnostics module `src/promotion/promotionPlatformDiagnostics.ts`, `npm run diagnose:platform`.
 *
 * Order of operations — preview deploy in **`src/deploy/`** (`runPreviewDeployment`, `resolvePreviewDeployAdapter`).
 * Production deploy is **separate**: `runProductionDeployment`, `productionDeployAdapterFactory`, `EdgeclawProductionDeployWorkflow`.
 *
 * 1. **Approved patches** — `SharedWorkspaceGateway` lifecycle (`approved` → optional `applied`); git lineage via `src/repo/` seam.
 * 2. **Promotion manifest** — `buildPromotionManifestFromApprovedPatches` → `ArtifactPromotionWriter.writeManifest` (`resolveArtifactPromotionWriter`).
 * 3. **Release gate** — `evaluatePromotionReleaseGate` / `resolveFlagshipEvaluationAdapter`. Sync: `runPreviewPromotionPipeline` / `runApprovedPatchesPreviewPipeline`; durable: `runPreviewPromotionWorkflow` + `EdgeclawPreviewPromotionWorkflow` (`launchPreviewPromotionWorkflow`).
 * 4. **Preview deploy** — `runPreviewDeployment` + `resolvePreviewDeployAdapter` (promotion-verified when persistence + flags allow; optional Workers Versions stub upload + witness; else noop).
 * 5. **Production deploy** — `runProductionDeployment` / `launchProductionDeployWorkflow` — stricter approvals; promotion-verified adapter when persistence + flags allow (`productionDeployAdapterFactory.ts`).
 *
 * Remaining before *enterprise* rollout (see Cloudflare docs under `docs/`):
 * - Flagship: enterprise policy (SLAs, regional rules, audit sinks) beyond string allow/deny/hold.
 * - Preview / production: full production Worker binary upload and traffic cutover via CI/Wangler remain outside orchestrator stub-upload path — see `preview-deploy-cloudflare.md` / `production-deploy-cloudflare.md`.
 */

export {};
