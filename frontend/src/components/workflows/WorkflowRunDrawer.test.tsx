import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { WorkflowRunDrawer }  from "./WorkflowRunDrawer";
import { WorkflowProgressBar } from "./WorkflowProgressBar";
import type { WorkflowRun, WorkflowStepState } from "../../types/workflows";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id:                   "run-test-1",
    workflowDefinitionId: "def-1",
    workflowName:         "Test Workflow",
    status:               "complete",
    startedAt:            "2025-01-03T09:00:00Z",
    updatedAt:            "2025-01-03T09:05:00Z",
    completedAt:          "2025-01-03T09:05:00Z",
    waitingForApproval:   false,
    ...overrides,
  };
}

function buildStep(overrides: Partial<WorkflowStepState> = {}): WorkflowStepState {
  return {
    stepName:  "Fetch data",
    status:    "complete",
    startedAt: "2025-01-03T09:00:00Z",
    ...overrides,
  };
}

/** Render the drawer with sensible callback stubs. */
function renderDrawer(
  run: WorkflowRun | undefined,
  props: {
    busy?:        boolean;
    onTerminate?: (id: string) => void;
    onApprove?:   (id: string, comment?: string) => void;
    onReject?:    (id: string, comment?: string) => void;
    onResume?:    (id: string) => void;
    onRestart?:   (id: string) => void;
    onClose?:     () => void;
  } = {},
) {
  const onTerminate = props.onTerminate ?? vi.fn();
  const onApprove   = props.onApprove   ?? vi.fn();
  const onReject    = props.onReject    ?? vi.fn();
  const onResume    = props.onResume    ?? vi.fn();
  const onRestart   = props.onRestart   ?? vi.fn();
  const onClose     = props.onClose     ?? vi.fn();

  render(
    <WorkflowRunDrawer
      run={run}
      busy={props.busy ?? false}
      onTerminate={onTerminate}
      onApprove={onApprove}
      onReject={onReject}
      onResume={onResume}
      onRestart={onRestart}
      onClose={onClose}
    />
  );

  return { onTerminate, onApprove, onReject, onResume, onRestart, onClose };
}

// ── 1. Drawer rendering — basic run information ───────────────────────────────

describe("Drawer rendering — basic run information", () => {
  it("renders nothing when run is undefined", () => {
    renderDrawer(undefined);
    expect(screen.queryByLabelText("Run inspector")).not.toBeInTheDocument();
  });

  it("renders the 'Run inspector' aside when a run is provided", () => {
    renderDrawer(buildRun());
    expect(screen.getByLabelText("Run inspector")).toBeInTheDocument();
  });

  it("shows the workflow name in the drawer header", () => {
    renderDrawer(buildRun({ workflowName: "My Special Workflow" }));
    expect(screen.getByText("My Special Workflow")).toBeInTheDocument();
  });

  it("shows the run ID in the subtitle", () => {
    renderDrawer(buildRun({ id: "run-xyz-789" }));
    expect(screen.getByText("run-xyz-789")).toBeInTheDocument();
  });

  it("shows the status badge text for a complete run", () => {
    renderDrawer(buildRun({ status: "complete" }));
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("shows the status badge text for a running run", () => {
    renderDrawer(buildRun({ status: "running" }));
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("shows the status badge text for an errored run", () => {
    renderDrawer(buildRun({ status: "errored" }));
    expect(screen.getByText("Errored")).toBeInTheDocument();
  });
});

// ── 2. Overview timing grid ───────────────────────────────────────────────────

describe("Overview timing grid", () => {
  it("renders the 'Started', 'Duration', 'Last updated', and 'Completed' labels", () => {
    renderDrawer(buildRun());
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("Last updated")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("shows the computed duration for a completed run", () => {
    renderDrawer(buildRun({
      startedAt:   "2025-01-03T09:00:00Z",
      completedAt: "2025-01-03T09:05:00Z",
    }));
    // Duration is 5 min → "5m"
    expect(screen.getByText("5m")).toBeInTheDocument();
  });

  it("shows '—' for Completed when the run has not yet finished", () => {
    renderDrawer(buildRun({ status: "running", completedAt: undefined }));
    // The "Completed" grid cell value should show em-dash
    const completedLabel = screen.getByText("Completed");
    const item = completedLabel.closest(".wf-run-overview-item");
    expect(item).toHaveTextContent("—");
  });
});

// ── 3. Progress bar rendering ─────────────────────────────────────────────────

describe("Progress bar rendering", () => {
  it("renders a progressbar with the correct aria-valuenow when progressPercent is set", () => {
    renderDrawer(buildRun({ status: "running", progressPercent: 42 }));
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("shows 100% for a complete run with explicit progressPercent: 100", () => {
    // WorkflowRunDrawer only renders the progress bar when progressPercent != null
    // or currentStep is set; set it explicitly to get a progressbar in the drawer.
    renderDrawer(buildRun({ status: "complete", progressPercent: 100 }));
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });

  it("shows the currentStep label when provided", () => {
    renderDrawer(buildRun({
      status:       "running",
      progressPercent: 60,
      currentStep:  "Processing records",
    }));
    expect(screen.getByText("Processing records")).toBeInTheDocument();
  });

  it("renders no progressbar when neither progressPercent nor currentStep is set", () => {
    // A run with no progress data and a non-terminal status that doesn't force 100
    renderDrawer(buildRun({ status: "running", progressPercent: undefined, currentStep: undefined }));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  // ── WorkflowProgressBar unit helpers ──────────────────────────────────────

  describe("WorkflowProgressBar helpers", () => {
    it("clamps progressPercent above 100 to 100", () => {
      render(<WorkflowProgressBar percent={120} status="running" />);
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
      cleanup();
    });

    it("clamps progressPercent below 0 to 0", () => {
      render(<WorkflowProgressBar percent={-10} status="running" />);
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
      cleanup();
    });

    it("renders nothing when no percent and status is not terminal", () => {
      const { container } = render(
        <WorkflowProgressBar percent={undefined} status="waiting" />
      );
      expect(container.firstChild).toBeNull();
      cleanup();
    });

    it("renders the step label even without a percent value", () => {
      render(<WorkflowProgressBar percent={undefined} status="running" currentStep="Sending email" />);
      expect(screen.getByText("Sending email")).toBeInTheDocument();
      cleanup();
    });
  });
});

// ── 4. Execution timeline ─────────────────────────────────────────────────────

describe("Execution timeline", () => {
  const steps: WorkflowStepState[] = [
    buildStep({ stepName: "Fetch data",  status: "complete", durationMs: 250     }),
    buildStep({ stepName: "Transform",   status: "complete", durationMs: 80_000  }), // 1m 20s
    buildStep({ stepName: "Export CSV",  status: "errored",  errorMessage: "Disk full" }),
    buildStep({ stepName: "Notify team", status: "pending" }),
  ];

  it("renders a heading 'Execution timeline' when steps are provided", () => {
    renderDrawer(buildRun({ steps }));
    expect(screen.getByText("Execution timeline")).toBeInTheDocument();
  });

  it("shows each step name", () => {
    renderDrawer(buildRun({ steps }));
    expect(screen.getByText("Fetch data")).toBeInTheDocument();
    expect(screen.getByText("Transform")).toBeInTheDocument();
    expect(screen.getByText("Export CSV")).toBeInTheDocument();
    expect(screen.getByText("Notify team")).toBeInTheDocument();
  });

  it("shows step status badges using the correct labels", () => {
    renderDrawer(buildRun({ steps }));
    expect(screen.getAllByText("Done").length).toBe(2);   // Fetch data + Transform
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("shows the step duration when durationMs is provided", () => {
    renderDrawer(buildRun({ steps }));
    expect(screen.getByText("250ms")).toBeInTheDocument();
    // fmtMs(80_000) = "1m 20s" — 80 seconds = 1 minute 20 seconds
    expect(screen.getByText("1m 20s")).toBeInTheDocument();
  });

  it("shows the error message for a failed step", () => {
    renderDrawer(buildRun({ steps }));
    expect(screen.getByText("Disk full")).toBeInTheDocument();
  });

  it("renders the '{complete} / {total} steps' progress label", () => {
    renderDrawer(buildRun({ steps }));
    // 2 complete out of 4 total
    expect(screen.getByText("2 / 4 steps")).toBeInTheDocument();
  });

  it("does not render the timeline section when steps is empty", () => {
    renderDrawer(buildRun({ steps: [] }));
    expect(screen.queryByText("Execution timeline")).not.toBeInTheDocument();
  });

  it("marks the last item with the is-last CSS modifier (no trailing connector)", () => {
    renderDrawer(buildRun({ steps }));
    const timelineItems = document.querySelectorAll(".wf-timeline-item");
    const lastItem = timelineItems[timelineItems.length - 1];
    expect(lastItem).toHaveClass("wf-timeline-item-last");
    // Earlier items must NOT have the last modifier
    expect(timelineItems[0]).not.toHaveClass("wf-timeline-item-last");
  });
});

// ── 5. Approval callout ───────────────────────────────────────────────────────

describe("Approval callout", () => {
  const waitingRun = buildRun({
    id:                 "run-w1",
    status:             "waiting",
    waitingForApproval: true,
  });

  it("shows 'Awaiting your approval' callout when waitingForApproval is true", () => {
    renderDrawer(waitingRun);
    expect(screen.getByText("Awaiting your approval")).toBeInTheDocument();
  });

  it("shows 'Approve run' and 'Reject run' buttons in the callout body", () => {
    renderDrawer(waitingRun);
    expect(screen.getByRole("button", { name: "Approve run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject run" })).toBeInTheDocument();
  });

  it("'Approve run' callout button calls onApprove with the run id and no comment when textarea is empty", () => {
    const { onApprove } = renderDrawer(waitingRun);
    fireEvent.click(screen.getByRole("button", { name: "Approve run" }));
    expect(onApprove).toHaveBeenCalledWith("run-w1", undefined);
  });

  it("'Approve run' passes the comment when reviewer types one", () => {
    const { onApprove } = renderDrawer(waitingRun);
    const textarea = screen.getByPlaceholderText(/add a note/i);
    fireEvent.change(textarea, { target: { value: "LGTM" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve run" }));
    expect(onApprove).toHaveBeenCalledWith("run-w1", "LGTM");
  });

  it("'Reject run' callout button calls onReject with the run id and no comment when textarea is empty", () => {
    const { onReject } = renderDrawer(waitingRun);
    fireEvent.click(screen.getByRole("button", { name: "Reject run" }));
    expect(onReject).toHaveBeenCalledWith("run-w1", undefined);
  });

  it("'Reject run' passes the comment when reviewer types one", () => {
    const { onReject } = renderDrawer(waitingRun);
    const textarea = screen.getByPlaceholderText(/add a note/i);
    fireEvent.change(textarea, { target: { value: "Does not meet requirements" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject run" }));
    expect(onReject).toHaveBeenCalledWith("run-w1", "Does not meet requirements");
  });

  it("does not show the approval callout when waitingForApproval is false", () => {
    renderDrawer(buildRun({ status: "running", waitingForApproval: false }));
    expect(screen.queryByText("Awaiting your approval")).not.toBeInTheDocument();
  });

  it("approval buttons and textarea are disabled when busy=true", () => {
    renderDrawer(waitingRun, { busy: true });
    // When busy, both action buttons render "…" and are disabled.
    const disabledBtns = screen.getAllByRole("button").filter((b) => b.hasAttribute("disabled"));
    expect(disabledBtns.length).toBeGreaterThanOrEqual(2);
    // The comment textarea is also disabled.
    const textarea = screen.getByPlaceholderText(/add a note/i);
    expect(textarea).toBeDisabled();
  });
});

// ── 6. Result summary callout ─────────────────────────────────────────────────

describe("Result summary callout", () => {
  it("shows the result summary when the run is complete and resultSummary is set", () => {
    renderDrawer(buildRun({
      status:        "complete",
      resultSummary: "Processed 1,240 rows — 3 errors.",
    }));
    expect(screen.getByText("Processed 1,240 rows — 3 errors.")).toBeInTheDocument();
  });

  it("does not render the result callout when resultSummary is absent", () => {
    renderDrawer(buildRun({ status: "complete", resultSummary: undefined }));
    expect(screen.queryByText(/processed/i)).not.toBeInTheDocument();
  });
});

// ── 7. Error block ────────────────────────────────────────────────────────────

describe("Error block", () => {
  it("shows the 'Error' section and the error message when status is errored", () => {
    renderDrawer(buildRun({ status: "errored", errorMessage: "Uncaught exception at step 3." }));
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Uncaught exception at step 3.")).toBeInTheDocument();
  });

  it("does not show the error block when errorMessage is absent", () => {
    renderDrawer(buildRun({ status: "complete", errorMessage: undefined }));
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });
});

// ── 8. Contextual action buttons ──────────────────────────────────────────────

describe("Contextual action buttons", () => {
  it("always shows the Close button in the footer", () => {
    renderDrawer(buildRun());
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("Close button calls onClose", () => {
    const { onClose } = renderDrawer(buildRun());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Close ✕ button in the header also calls onClose", () => {
    const { onClose } = renderDrawer(buildRun());
    fireEvent.click(screen.getByRole("button", { name: "Close run inspector" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a Terminate button for a running run and calls onTerminate", () => {
    const run = buildRun({ id: "run-r1", status: "running", waitingForApproval: false });
    const { onTerminate } = renderDrawer(run);
    const btn = screen.getByRole("button", { name: "Terminate" });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onTerminate).toHaveBeenCalledWith("run-r1");
  });

  it("does not show a Terminate button for a completed run", () => {
    renderDrawer(buildRun({ status: "complete" }));
    expect(screen.queryByRole("button", { name: "Terminate" })).not.toBeInTheDocument();
  });

  it("shows 'Resume run' for a paused run and calls onResume", () => {
    const run = buildRun({ id: "run-p1", status: "paused" });
    const { onResume } = renderDrawer(run);
    const btn = screen.getByRole("button", { name: "Resume run" });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onResume).toHaveBeenCalledWith("run-p1");
  });

  it("does not show 'Resume run' for a running run", () => {
    renderDrawer(buildRun({ status: "running" }));
    expect(screen.queryByRole("button", { name: "Resume run" })).not.toBeInTheDocument();
  });

  it("shows 'Restart run' for a completed run and calls onRestart", () => {
    const run = buildRun({ id: "run-c1", status: "complete" });
    const { onRestart } = renderDrawer(run);
    const btn = screen.getByRole("button", { name: "Restart run" });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onRestart).toHaveBeenCalledWith("run-c1");
  });

  it("shows 'Restart run' for an errored run", () => {
    renderDrawer(buildRun({ status: "errored" }));
    expect(screen.getByRole("button", { name: "Restart run" })).toBeInTheDocument();
  });

  it("shows 'Restart run' for a terminated run", () => {
    renderDrawer(buildRun({ status: "terminated" }));
    expect(screen.getByRole("button", { name: "Restart run" })).toBeInTheDocument();
  });

  it("action buttons are disabled when busy=true", () => {
    const run = buildRun({ status: "running", waitingForApproval: false });
    renderDrawer(run, { busy: true });
    expect(screen.getByRole("button", { name: "Terminate" })).toBeDisabled();
  });
});

// ── 9. Payload blocks ─────────────────────────────────────────────────────────

describe("Payload blocks", () => {
  it("renders 'Input' and 'Output' payload toggles", () => {
    renderDrawer(buildRun());
    expect(screen.getByRole("button", { name: /input/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /output/i })).toBeInTheDocument();
  });

  it("expanding the Input toggle reveals the JSON payload", () => {
    renderDrawer(buildRun({ input: { targetDate: "2026-01-01" } }));
    fireEvent.click(screen.getByRole("button", { name: /input/i }));
    expect(screen.getByText(/"targetDate"/)).toBeInTheDocument();
  });

  it("Input toggle is disabled when no input data is present", () => {
    renderDrawer(buildRun({ input: undefined }));
    expect(screen.getByRole("button", { name: /input/i })).toBeDisabled();
  });
});

// ── 10. Error section (Phase 2 enhancements) ──────────────────────────────────

describe("Error section — enhanced display", () => {
  it("shows error message in a preformatted block when errorMessage is set", () => {
    renderDrawer(buildRun({ status: "errored", errorMessage: "Quota exceeded" }));
    expect(screen.getByText("Quota exceeded")).toBeInTheDocument();
  });

  it("shows errorCode as a code badge when set", () => {
    renderDrawer(buildRun({ status: "errored", errorMessage: "oops", errorCode: "E_QUOTA" }));
    expect(screen.getByText("E_QUOTA")).toBeInTheDocument();
  });

  it("shows 'Error details' toggle when errorDetails is present", () => {
    renderDrawer(buildRun({
      status:       "errored",
      errorMessage: "Unexpected error",
      errorDetails: { stack: "at line 42" },
    }));
    expect(screen.getByRole("button", { name: /error details/i })).toBeInTheDocument();
  });

  it("does not show 'Error details' toggle when errorDetails is absent", () => {
    renderDrawer(buildRun({ status: "errored", errorMessage: "oops" }));
    expect(screen.queryByRole("button", { name: /error details/i })).not.toBeInTheDocument();
  });

  it("expanding error details shows the JSON payload", () => {
    renderDrawer(buildRun({
      status:       "errored",
      errorMessage: "oops",
      errorDetails: { stack: "at line 42" },
    }));
    fireEvent.click(screen.getByRole("button", { name: /error details/i }));
    expect(screen.getByText(/"stack"/)).toBeInTheDocument();
  });

  it("renders nothing in the error section when no error fields are set", () => {
    renderDrawer(buildRun({ status: "complete", errorMessage: null }));
    // The section title "Error" should not appear.
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });
});

// ── 11. Timeline scalability controls ─────────────────────────────────────────

describe("Execution timeline — scalability controls", () => {
  it("renders all steps when there are 5 or fewer (no expand button)", () => {
    const steps = Array.from({ length: 5 }, (_, i) =>
      buildStep({ stepName: `Step ${i + 1}`, status: "complete" })
    );
    renderDrawer(buildRun({ steps }));
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Step ${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /show all/i })).not.toBeInTheDocument();
  });

  it("shows only the first 4 steps and a 'Show all' button when there are more than 5", () => {
    const steps = Array.from({ length: 8 }, (_, i) =>
      buildStep({ stepName: `Step ${i + 1}`, status: "complete" })
    );
    renderDrawer(buildRun({ steps }));
    expect(screen.getByRole("button", { name: /show all 8 steps/i })).toBeInTheDocument();
    // Step 5+ should be hidden.
    expect(screen.queryByText("Step 5")).not.toBeInTheDocument();
  });

  it("clicking 'Show all' expands to show all steps", () => {
    const steps = Array.from({ length: 8 }, (_, i) =>
      buildStep({ stepName: `Step ${i + 1}`, status: "complete" })
    );
    renderDrawer(buildRun({ steps }));
    fireEvent.click(screen.getByRole("button", { name: /show all/i }));
    expect(screen.getByText("Step 5")).toBeInTheDocument();
    expect(screen.getByText("Step 8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show fewer/i })).toBeInTheDocument();
  });

  it("clicking 'Show fewer' collapses the timeline again", () => {
    const steps = Array.from({ length: 8 }, (_, i) =>
      buildStep({ stepName: `Step ${i + 1}`, status: "complete" })
    );
    renderDrawer(buildRun({ steps }));
    fireEvent.click(screen.getByRole("button", { name: /show all/i }));
    fireEvent.click(screen.getByRole("button", { name: /show fewer/i }));
    expect(screen.queryByText("Step 5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show all/i })).toBeInTheDocument();
  });

  it("shows filter buttons for All / Active / Errors when timeline has more than 1 step", () => {
    const steps = [
      buildStep({ stepName: "Ingest",    status: "complete" }),
      buildStep({ stepName: "Transform", status: "errored" }),
    ];
    renderDrawer(buildRun({ steps }));
    expect(screen.getByRole("button", { name: /^all/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^active/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^errors/i })).toBeInTheDocument();
  });

  it("filtering to 'Errors' shows only errored steps", () => {
    const steps = [
      buildStep({ stepName: "Ingest",    status: "complete" }),
      buildStep({ stepName: "Transform", status: "errored", errorMessage: "OOM" }),
    ];
    renderDrawer(buildRun({ steps }));
    fireEvent.click(screen.getByRole("button", { name: /^errors/i }));
    expect(screen.queryByText("Ingest")).not.toBeInTheDocument();
    expect(screen.getByText("Transform")).toBeInTheDocument();
  });

  it("shows empty message when filter yields no results", () => {
    const steps = [
      buildStep({ stepName: "Ingest",  status: "complete" }),
      buildStep({ stepName: "Publish", status: "complete" }),
    ];
    renderDrawer(buildRun({ steps }));
    // Filter to Errors — no errored steps exist.
    fireEvent.click(screen.getByRole("button", { name: /^errors/i }));
    expect(screen.getByText(/no steps match/i)).toBeInTheDocument();
  });

  it("shows error count in the header when there are errored steps", () => {
    const steps = [
      buildStep({ stepName: "Ingest", status: "complete" }),
      buildStep({ stepName: "Load",   status: "errored" }),
    ];
    renderDrawer(buildRun({ steps }));
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it("does not show filter buttons when there is exactly 1 step", () => {
    const steps = [buildStep({ stepName: "OnlyStep", status: "complete" })];
    renderDrawer(buildRun({ steps }));
    expect(screen.queryByRole("button", { name: /^all/i })).not.toBeInTheDocument();
  });
});

// ── 12. Approval audit display ────────────────────────────────────────────────

describe("Approval audit record", () => {
  it("shows '✓ Approved' label when approvalAction is 'approved'", () => {
    renderDrawer(buildRun({
      status:           "running",
      waitingForApproval: false,
      approvalAction:   "approved",
    }));
    expect(screen.getByText(/✓ Approved/)).toBeInTheDocument();
  });

  it("shows '✕ Rejected' label when approvalAction is 'rejected'", () => {
    renderDrawer(buildRun({
      status:           "terminated",
      waitingForApproval: false,
      approvalAction:   "rejected",
    }));
    expect(screen.getByText(/✕ Rejected/)).toBeInTheDocument();
  });

  it("shows 'by' the approver name when approvedBy is set", () => {
    renderDrawer(buildRun({
      approvalAction: "approved",
      approvedBy:     "Alice",
    }));
    expect(screen.getByText(/by Alice/)).toBeInTheDocument();
  });

  it("shows the comment in a blockquote when approvalComment is set", () => {
    renderDrawer(buildRun({
      approvalAction:  "approved",
      approvalComment: "Looks good",
    }));
    expect(screen.getByText("Looks good")).toBeInTheDocument();
  });

  it("renders nothing when approvalAction is absent", () => {
    renderDrawer(buildRun({ approvalAction: null }));
    expect(screen.queryByText(/✓ Approved/)).not.toBeInTheDocument();
    expect(screen.queryByText(/✕ Rejected/)).not.toBeInTheDocument();
  });
});
