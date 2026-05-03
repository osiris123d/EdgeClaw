/**
 * CLI: staging operational summary for **empty** env (local diagnose).
 * Deployed Worker: `GET /api/ops/staging-report` with `Authorization: Bearer <STAGING_OPS_TOKEN>` for live JSON.
 *
 *   npm run diagnose:staging
 */

import type { Env } from "../lib/env";
import {
  formatStagingOperationalSummaryReport,
  runStagingPromotionSmoke,
} from "./promotionOperationalStaging";

async function main(): Promise<void> {
  const env = {} as Env;
  console.log(formatStagingOperationalSummaryReport(env));
  console.log("");
  console.log("--- Async prepare probe (empty env → skipped_no_shared_workspace_kv) ---");
  const smoke = await runStagingPromotionSmoke(env);
  console.log(JSON.stringify(smoke, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
