/**
 * Production deployment policy — **separate** from preview (`previewDeployTypes.ts`).
 *
 * ## Approvals
 *
 * - Release gate must evaluate **`tier: "production"`** with **`outcome: "allow"`** before any production adapter runs.
 * - **`productionApprovals`** must list **at least {@link PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS}** distinct
 *   `approverId` values (human SSO subjects, service accounts, or ticket bots — auditable strings).
 * - Optional **`changeTicketId`** links CAB / change-management records; future adapters may require it via env.
 *
 * ## Rollout constraints
 *
 * - Production deploy adapters should treat **`PromotionArtifactRef`** (`storageUri`, `manifestDigest`) as the trust root,
 *   mirroring preview R2 verification patterns.
 * - Long-running uploads belong in **Workflow** steps (`EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW`) — do not block the chat DO on Wrangler/API calls.
 *
 * ## Rollback expectations
 *
 * - Successful **`ProductionDeployResult`** should populate **`rollbackHint`** and/or **`previousStableIdentifier`** when the backend exposes them.
 * - Noop adapters cannot mutate Workers versions — rollback is manual (redeploy previous artifact / revert routes). Document incident links in `audit`.
 */

/** Minimum distinct approver identities required on the production path (policy gate before adapter). */
export const PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS = 2;
