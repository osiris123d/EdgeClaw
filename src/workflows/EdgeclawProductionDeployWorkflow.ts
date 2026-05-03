/**
 * EdgeclawProductionDeployWorkflow
 *
 * Durable **production** deployment step — separate from preview workflows.
 *
 * Binding: `EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW`
 *
 * Delegates to MainAgent {@link executeProductionDeployment} via RPC so promotion adapters and env resolve on the orchestrator DO.
 *
 * **Boundary:** Initiated by MainAgent `launchProductionDeployWorkflow` — not CoderAgent/TesterAgent.
 */

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { MainAgent } from "../agents/MainAgent";
import type { ProductionDeployRequest, ProductionDeployResult } from "../deploy/productionDeployTypes";

export type ProductionDeployWorkflowOutput = ProductionDeployResult & {
  workflowInstanceId: string;
  workflowName: string;
};

export class EdgeclawProductionDeployWorkflow extends AgentWorkflow<MainAgent> {
  async run(event: AgentWorkflowEvent, step: AgentWorkflowStep): Promise<ProductionDeployWorkflowOutput> {
    const agent = this.agent;
    const payload = event.payload as ProductionDeployRequest;

    const result = await step.do("production-deploy", async (): Promise<ProductionDeployResult> => {
      await this.reportProgress({
        step: "production-deploy",
        status: "running",
        percent: 0.5,
        pipeline: "production-deploy",
        projectId: payload.projectId,
      });
      const out = await agent.executeProductionDeployment(payload);
      await this.reportProgress({
        step: "production-deploy",
        status: "complete",
        percent: 1,
        pipeline: "production-deploy",
        deployStatus: out.status,
      });
      return out;
    });

    const output: ProductionDeployWorkflowOutput = {
      ...result,
      workflowInstanceId: this.workflowId,
      workflowName: this.workflowName,
    };

    await step.reportComplete(output);
    return output;
  }
}
