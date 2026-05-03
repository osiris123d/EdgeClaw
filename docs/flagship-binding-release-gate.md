# Flagship binding release gate

## Adapter stack

`resolveFlagshipEvaluationAdapter` (`src/promotion/flagshipEvaluationAdapterFactory.ts`) selects:

1. **Workers binding** — when `ENABLE_FLAGSHIP_BINDING` is `true`/`1`/`on` **and** `env.FLAGS` is bound (Wrangler `flagship` → typically `FLAGS`).
2. **HTTP** — when `ENABLE_FLAGSHIP_HTTP` is not off **and** `FLAGSHIP_EVALUATION_URL` is set (`flagshipHttp.ts`).
3. **Noop** — safe default for development (`flagshipNoop.ts`).

`evaluatePromotionReleaseGate` (`orchestratorReleaseGate.ts`) stays orchestrator-only; it forwards digest / verification refs / `correlationId` into `FlagshipEvaluationAdapter.evaluate` unchanged.

## Binding contract

- Configure a **string** flag in Flagship whose key matches `FLAGSHIP_RELEASE_GATE_FLAG_KEY` (default `edgeclaw-release-gate`).
- Allowed values: **`allow`**, **`deny`**, **`hold`** (case-insensitive). Other values normalize to **`hold`** with reason code `FLAGSHIP_BINDING_UNKNOWN_VALUE`.
- Targeting attributes include `projectId`, `bundleId`, `tier`, optional `manifestDigest`, `correlationId`, and comma-joined `verificationRefs` (see `toFlagshipTargetingAttributes` in `flagshipBinding.ts`).
- If Flagship returns `errorCode` on `getStringDetails`, the adapter **denies** (`FLAGSHIP_BINDING_ERROR`).

## Wrangler

See commented `flagship` block in `wrangler.jsonc`. The binding name must be **`FLAGS`** to match `Env.FLAGS` (Cloudflare’s default example).

## Production rollout (deferred)

- Align string flag keys across preview/canary/production environments; optional **per-tier flag keys** are not implemented yet.
- Rich structured reasons from an **object flag** (instead of string outcome + audit fields) is deferred.
- HTTP policy service may still be preferred for centralized policy logic; binding path suits Flagship-native targeting and gradual migration.
