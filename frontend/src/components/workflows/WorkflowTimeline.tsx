/**
 * WorkflowTimeline
 *
 * Execution timeline for a workflow run.  Supports:
 *   - Collapse / expand when there are more than COLLAPSE_THRESHOLD steps
 *   - Step-status filter (All / Active / Errors only)
 *   - Error count hint in the section header
 *
 * Props:
 *   steps           — ordered list of step states from the run
 *   mobileCollapsed — when true, start in collapsed state (caller sets this on
 *                     narrow viewports by reading window.innerWidth at mount)
 */

import { useState, useEffect } from "react";
import type { WorkflowStepState } from "../../types/workflows";
import { fmtMs, fmtRelative } from "../../lib/workflowFormatters";

// ── Constants ─────────────────────────────────────────────────────────────────

const COLLAPSE_THRESHOLD = 5;  // show all when ≤ this many steps
const DEFAULT_VISIBLE    = 4;  // how many to show in collapsed mode

// ── Types ─────────────────────────────────────────────────────────────────────

type StepFilter = "all" | "running" | "errors";

// ── Step status labels + badges ───────────────────────────────────────────────

const STEP_STATUS_LABELS: Record<WorkflowStepState["status"], string> = {
  pending:  "Pending",
  running:  "Running",
  complete: "Done",
  errored:  "Failed",
  skipped:  "Skipped",
};

function StepStatusBadge({ status }: { status: WorkflowStepState["status"] }) {
  return (
    <span className={`wf-step-badge wf-step-badge-${status}`}>
      {STEP_STATUS_LABELS[status]}
    </span>
  );
}

function StepDot({ status }: { status: WorkflowStepState["status"] }) {
  return (
    <div
      className={`wf-timeline-dot wf-timeline-dot-${status}`}
      aria-hidden="true"
    />
  );
}

// ── Individual step row ───────────────────────────────────────────────────────

function TimelineStep({
  step,
  isLast,
}: {
  step:   WorkflowStepState;
  isLast: boolean;
}) {
  const hasTiming = step.startedAt ?? step.completedAt;
  const duration  = step.durationMs != null ? fmtMs(step.durationMs) : null;

  return (
    <div className={`wf-timeline-item${isLast ? " wf-timeline-item-last" : ""}`}>
      <div className="wf-timeline-left">
        <StepDot status={step.status} />
      </div>

      <div className="wf-timeline-content">
        <div className="wf-timeline-step-header">
          <span className="wf-timeline-step-name">{step.stepName}</span>
          <StepStatusBadge status={step.status} />
          {duration && (
            <span className="wf-timeline-step-duration">{duration}</span>
          )}
        </div>

        {hasTiming && (
          <div className="wf-timeline-step-times">
            {step.startedAt && (
              <span title={new Date(step.startedAt).toLocaleString()}>
                {fmtRelative(step.startedAt)}
              </span>
            )}
            {step.completedAt && step.startedAt && (
              <span className="wf-timeline-step-arrow" aria-hidden="true">→</span>
            )}
            {step.completedAt && (
              <span title={new Date(step.completedAt).toLocaleString()}>
                {fmtRelative(step.completedAt)}
              </span>
            )}
          </div>
        )}

        {step.errorMessage && (
          <div className="wf-timeline-step-error" role="alert">
            {step.errorMessage}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface WorkflowTimelineProps {
  steps:           WorkflowStepState[];
  mobileCollapsed?: boolean;
}

export function WorkflowTimeline({ steps, mobileCollapsed }: WorkflowTimelineProps) {
  const isLong = steps.length > COLLAPSE_THRESHOLD;

  const [expanded,   setExpanded]   = useState(!isLong);
  const [stepFilter, setStepFilter] = useState<StepFilter>("all");

  // On mobile, collapse long timelines by default.
  useEffect(() => {
    if (mobileCollapsed && isLong) setExpanded(false);
  }, [mobileCollapsed, isLong]);

  if (steps.length === 0) return null;

  // Derived counts (computed once per render).
  const complete   = steps.filter((s) => s.status === "complete").length;
  const errorCount = steps.filter((s) => s.status === "errored").length;
  const activeCount = steps.filter(
    (s) => s.status === "running" || s.status === "pending",
  ).length;

  // Apply the active filter.
  const filtered =
    stepFilter === "all"
      ? steps
      : stepFilter === "running"
        ? steps.filter((s) => s.status === "running" || s.status === "pending")
        : steps.filter((s) => s.status === "errored");

  const visible    = expanded ? filtered : filtered.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = filtered.length - DEFAULT_VISIBLE;

  // ── Filter controls ─────────────────────────────────────────────────────────

  const filters: Array<{ id: StepFilter; label: string; count: number }> = [
    { id: "all",     label: "All",    count: steps.length },
    { id: "running", label: "Active", count: activeCount },
    { id: "errors",  label: "Errors", count: errorCount },
  ];

  return (
    <div className="wf-drawer-section">

      {/* Section header */}
      <div className="wf-timeline-header">
        <span className="wf-drawer-section-title" style={{ margin: 0 }}>
          Execution timeline
        </span>
        <span className="wf-timeline-progress-label">
          {complete} / {steps.length} steps
          {errorCount > 0 && (
            <span className="wf-timeline-error-count"> · {errorCount} failed</span>
          )}
        </span>
      </div>

      {/* Filter chips — only shown when there is more than one step */}
      {steps.length > 1 && (
        <div className="wf-timeline-filters" role="group" aria-label="Filter timeline steps">
          {filters.map(({ id, label, count }) => (
            <button
              key={id}
              type="button"
              className={`wf-timeline-filter-btn${stepFilter === id ? " is-active" : ""}`}
              aria-pressed={stepFilter === id}
              onClick={() => setStepFilter(id)}
            >
              {label}
              {count > 0 && (
                <span className="wf-timeline-filter-count" aria-hidden="true">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Steps list */}
      <div className="wf-timeline">
        {filtered.length === 0 ? (
          <p className="wf-timeline-empty">No steps match the selected filter.</p>
        ) : (
          visible.map((step, i) => (
            <TimelineStep
              key={step.stepName}
              step={step}
              isLast={i === visible.length - 1 && (expanded || hiddenCount <= 0)}
            />
          ))
        )}
      </div>

      {/* Expand / collapse control */}
      {filtered.length > DEFAULT_VISIBLE && (
        <button
          type="button"
          className="wf-timeline-expand-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded
            ? "Show fewer"
            : `Show all ${filtered.length} steps`}
        </button>
      )}

    </div>
  );
}
