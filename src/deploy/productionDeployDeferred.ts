/**
 * Production deployment — type exports + policy constant.
 *
 * Runtime wiring: `productionDeployAdapterFactory.ts`, `orchestratorProductionDeploy.ts`, `EdgeclawProductionDeployWorkflow`.
 * **Architecture:** `docs/coding-platform-architecture.md`
 */

export type {
  ProductionDeployAdapter,
  ProductionDeployRequest,
  ProductionDeployResult,
} from "./productionDeployTypes";

export { PRODUCTION_DEPLOY_MIN_DISTINCT_APPROVERS } from "./productionDeployPolicy";
