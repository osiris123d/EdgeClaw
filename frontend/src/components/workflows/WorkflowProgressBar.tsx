import type { WorkflowRunStatus } from "../../types/workflows";

interface WorkflowProgressBarProps {
  percent?:     number | null;
  status:       WorkflowRunStatus;
  currentStep?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function effectivePct(percent: number | null | undefined, status: WorkflowRunStatus): number {
  if (percent != null) return Math.max(0, Math.min(100, percent));
  if (status === "complete")   return 100;
  if (status === "errored")    return 100;
  if (status === "terminated") return 100;
  return 0;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WorkflowProgressBar({ percent, status, currentStep }: WorkflowProgressBarProps) {
  const pct     = effectivePct(percent, status);
  const hasData = percent != null || status === "complete" || status === "errored" || status === "terminated";

  if (!hasData && !currentStep) return null;

  return (
    <div className="wf-progress-wrap">
      {hasData && (
        <div className="wf-progress-row">
          <div className="wf-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`wf-progress-fill wf-progress-fill-${status}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="wf-progress-pct">{pct}%</span>
        </div>
      )}
      {currentStep && (
        <span className="wf-progress-step" title={currentStep}>
          {currentStep}
        </span>
      )}
    </div>
  );
}
