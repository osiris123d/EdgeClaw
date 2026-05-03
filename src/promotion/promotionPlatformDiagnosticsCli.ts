/**
 * CLI smoke: prints diagnostics for an **empty** env (all fallbacks / noop).
 * For real branches, call `formatPromotionPlatformDiagnosticsReport(env)` from the Worker
 * (or a one-off test) with the live `env` object.
 *
 *   npx tsx src/promotion/promotionPlatformDiagnosticsCli.ts
 */

import type { Env } from "../lib/env";
import { formatPromotionPlatformDiagnosticsReport } from "./promotionPlatformDiagnostics";

const env = {} as Env;
console.log(formatPromotionPlatformDiagnosticsReport(env));
