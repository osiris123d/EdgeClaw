/**
 * EdgeclawPreviewPromotionWorkflow
 *
 * Durable preview promotion pipeline: approved patches → manifest → R2/noop artifact → Flagship gate → preview deploy.
 *
 * Binding key (must match wrangler.jsonc):
 *   EDGECLAW_PREVIEW_PROMOTION_WORKFLOW
 *
 * **Initiation:** MainAgent calls `runWorkflow("EDGECLAW_PREVIEW_PROMOTION_WORKFLOW", payload)` or
 * `launchPreviewPromotionWorkflow()` — not CoderAgent/TesterAgent.
 *
 * **RPC:** Uses `this.agent` (MainAgent stub) for `prepareApprovedPromotion`, `buildPromotionArtifact`,
 * `evaluateReleaseGate`, `executePreviewDeployment` so env bindings (R2, gateway KV, adapters) resolve on the orchestrator DO.
 *
 * Logic lives in `src/promotion/previewPromotionWorkflowLogic.ts` for unit tests without Workflow runtime.
 */

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { MainAgent } from "../agents/MainAgent";
import type { PreviewPromotionPipelineInput } from "../promotion/orchestratorPreviewPromotionPipeline";
import {
  runPreviewPromotionWorkflow,
  type PreviewPromotionWorkflowRunResult,
} from "../promotion/previewPromotionWorkflowLogic";

export type PreviewPromotionWorkflowOutput = PreviewPromotionWorkflowRunResult & {
  workflowInstanceId: string;
  workflowName: string;
};

export class EdgeclawPreviewPromotionWorkflow extends AgentWorkflow<MainAgent> {
  async run(event: AgentWorkflowEvent, step: AgentWorkflowStep): Promise<PreviewPromotionWorkflowOutput> {
    const agent = this.agent;
    const payload = event.payload as PreviewPromotionPipelineInput;

    const runResult = await runPreviewPromotionWorkflow(
      payload,
      step,
      {
        prepareApprovedPromotion: (projectId, patchIds, options) =>
          agent.prepareApprovedPromotion(projectId, patchIds, options),
        buildPromotionArtifact: (manifest) => agent.buildPromotionArtifact(manifest),
        evaluateReleaseGate: (params) => agent.evaluateReleaseGate(params),
        executePreviewDeployment: (request) => agent.executePreviewDeployment(request),
      },
      {
        reportProgress: (data) => this.reportProgress(data),
      }
    );

    const output: PreviewPromotionWorkflowOutput = {
      ...runResult,
      workflowInstanceId: this.workflowId,
      workflowName: this.workflowName,
    };

    await step.reportComplete(output);
    return output;
  }
}
