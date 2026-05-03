import type { CodingCollaborationLoopResult } from "../agents/codingLoop/codingLoopTypes";
import type { CoordinatorTaskStatus } from "../coordinatorControlPlane/types";

/** Explicit terminal reason for bounded project autonomy (audit / UI). */
export type ProjectAutonomyStopReason =
  | "no_runnable_tasks"
  | "dependency_unmet"
  | "project_archived"
  | "project_not_ready"
  | "project_not_found"
  | "blocked"
  | "review_required"
  | "follow_up_tasks_created"
  | "max_steps_reached"
  | "project_complete_candidate";

export interface ProjectAutonomyStepRecord {
  taskId: string;
  selectionReason: string;
  loopTerminalStatus: CodingCollaborationLoopResult["status"];
  taskStatusAfter?: CoordinatorTaskStatus;
  followUpTaskIds: string[];
  /** Loop summary line for audit. */
  summaryPreview?: string;
}

export interface ProjectAutonomyScenarioResult {
  debug: true;
  autonomy: true;
  projectId: string;
  sessionId: string;
  maxStepsRequested: number;
  stepsExecuted: number;
  stopReason: ProjectAutonomyStopReason;
  steps: ProjectAutonomyStepRecord[];
  /** Count of follow-up tasks created across all steps (from orchestration meta). */
  totalFollowUpsCreated: number;
  /** Present when the run stopped on pick failure with dependency detail (optional). */
  pickAudit?: {
    skippedDueToDependencies?: { taskId: string; unmet: string[] }[];
  };
}
