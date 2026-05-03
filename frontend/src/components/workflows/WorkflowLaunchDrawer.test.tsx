/**
 * WorkflowLaunchDrawer.test.tsx
 *
 * Focused tests for the new launch drawer component:
 *   - Renders nothing when definition is undefined (closed)
 *   - Displays workflow metadata chips
 *   - "Use example" button fills the textarea
 *   - JSON validation shows inline error and prevents launch
 *   - Valid JSON payload is passed to onLaunch
 *   - Empty payload calls onLaunch with undefined
 *   - Success state renders after launchResult is set
 *   - "View run" in success state calls onViewRun + onClose
 *   - Cancel calls onClose
 */

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { WorkflowLaunchDrawer } from "./WorkflowLaunchDrawer";
import type { WorkflowDefinition, WorkflowRun } from "../../types/workflows";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id:           "def-1",
    name:         "Daily Report",
    description:  "Builds the daily report",
    workflowType: "report",
    triggerMode:  "manual",
    approvalMode: "none",
    status:       "active",
    entrypoint:   "DAILY_REPORT",
    enabled:      true,
    tags:         [],
    runCount:     3,
    createdAt:    "2025-01-01T00:00:00Z",
    updatedAt:    "2025-01-02T00:00:00Z",
    examplePayloadText: '{"env":"prod"}',
    inputSchemaText:    '{"type":"object","properties":{"env":{"type":"string"}}}',
    ...overrides,
  };
}

function buildRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id:                   "run-xyz-1",
    workflowDefinitionId: "def-1",
    workflowName:         "Daily Report",
    status:               "running",
    startedAt:            "2025-01-03T09:00:00Z",
    updatedAt:            "2025-01-03T09:00:05Z",
    waitingForApproval:   false,
    ...overrides,
  };
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderDrawer(
  definition: WorkflowDefinition | undefined,
  options: {
    launching?:    boolean;
    launchResult?: WorkflowRun;
    onLaunch?:     (id: string, payload?: Record<string, unknown>) => void;
    onViewRun?:    (run: WorkflowRun) => void;
    onClose?:      () => void;
  } = {},
) {
  const onLaunch  = options.onLaunch  ?? vi.fn();
  const onViewRun = options.onViewRun ?? vi.fn();
  const onClose   = options.onClose   ?? vi.fn();

  render(
    <WorkflowLaunchDrawer
      definition={definition}
      launching={options.launching ?? false}
      launchResult={options.launchResult}
      onLaunch={onLaunch}
      onViewRun={onViewRun}
      onClose={onClose}
    />
  );

  return { onLaunch, onViewRun, onClose };
}

// ── 1. Drawer closed state ────────────────────────────────────────────────────

describe("Drawer closed state", () => {
  it("renders nothing when definition is undefined", () => {
    renderDrawer(undefined);
    expect(screen.queryByLabelText(/launch/i)).not.toBeInTheDocument();
  });
});

// ── 2. Drawer open state ──────────────────────────────────────────────────────

describe("Drawer open state", () => {
  it("shows the workflow name in the header", () => {
    renderDrawer(buildDef());
    expect(screen.getByText("Daily Report")).toBeInTheDocument();
  });

  it("shows trigger mode chip", () => {
    renderDrawer(buildDef({ triggerMode: "manual" }));
    expect(screen.getByText("Manual")).toBeInTheDocument();
  });

  it("shows approval mode chip", () => {
    renderDrawer(buildDef({ approvalMode: "required" }));
    expect(screen.getByText("Approval required")).toBeInTheDocument();
  });

  it("shows workflow type chip when provided", () => {
    renderDrawer(buildDef({ workflowType: "report" }));
    expect(screen.getByText("report")).toBeInTheDocument();
  });

  it("shows description when provided", () => {
    renderDrawer(buildDef({ description: "Builds the daily report" }));
    expect(screen.getByText("Builds the daily report")).toBeInTheDocument();
  });

  it("shows payload textarea", () => {
    renderDrawer(buildDef());
    expect(screen.getByLabelText(/input payload/i)).toBeInTheDocument();
  });

  it("shows 'Use example' button when examplePayloadText is set", () => {
    renderDrawer(buildDef({ examplePayloadText: '{"env":"prod"}' }));
    expect(screen.getByRole("button", { name: /use example/i })).toBeInTheDocument();
  });

  it("does not show 'Use example' button when examplePayloadText is absent", () => {
    renderDrawer(buildDef({ examplePayloadText: undefined }));
    expect(screen.queryByRole("button", { name: /use example/i })).not.toBeInTheDocument();
  });

  it("shows 'Input schema' toggle when inputSchemaText is set", () => {
    renderDrawer(buildDef());
    expect(screen.getByRole("button", { name: /input schema/i })).toBeInTheDocument();
  });

  it("shows Cancel and Launch buttons", () => {
    renderDrawer(buildDef());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    // At least one Launch button (the footer confirm button)
    const launchBtns = screen.getAllByRole("button", { name: /^launch$/i });
    expect(launchBtns.length).toBeGreaterThan(0);
  });
});

// ── 3. "Use example" functionality ───────────────────────────────────────────

describe("Use example payload button", () => {
  it("fills the textarea with the example payload on click", () => {
    renderDrawer(buildDef({ examplePayloadText: '{"env":"prod"}' }));
    fireEvent.click(screen.getByRole("button", { name: /use example/i }));
    const textarea = screen.getByLabelText(/input payload/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('{"env":"prod"}');
  });

  it("clears any previous validation error when example is applied", () => {
    renderDrawer(buildDef({ examplePayloadText: '{"env":"prod"}' }));
    // First introduce a validation error.
    const textarea = screen.getByLabelText(/input payload/i);
    fireEvent.change(textarea, { target: { value: "{ bad json" } });
    const launchBtn = screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!;
    fireEvent.click(launchBtn);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Now click Use example — error should clear.
    fireEvent.click(screen.getByRole("button", { name: /use example/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// ── 4. Input schema toggle ────────────────────────────────────────────────────

describe("Input schema toggle", () => {
  it("is collapsed by default — schema body is not visible", () => {
    renderDrawer(buildDef());
    expect(screen.queryByText(/"type":"object"/)).not.toBeInTheDocument();
  });

  it("expands when toggle is clicked", () => {
    renderDrawer(buildDef());
    fireEvent.click(screen.getByRole("button", { name: /input schema/i }));
    expect(screen.getByText(/"type":"object"/)).toBeInTheDocument();
  });
});

// ── 5. JSON validation ────────────────────────────────────────────────────────

describe("JSON validation", () => {
  it("shows an error for malformed JSON", () => {
    renderDrawer(buildDef());
    const textarea = screen.getByLabelText(/input payload/i);
    fireEvent.change(textarea, { target: { value: "{ not json" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!);
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid json/i);
  });

  it("shows an error when payload is a JSON array (not an object)", () => {
    renderDrawer(buildDef());
    const textarea = screen.getByLabelText(/input payload/i);
    fireEvent.change(textarea, { target: { value: "[1, 2, 3]" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!);
    expect(screen.getByRole("alert")).toHaveTextContent(/json object/i);
  });

  it("does not call onLaunch when validation fails", () => {
    const { onLaunch } = renderDrawer(buildDef());
    const textarea = screen.getByLabelText(/input payload/i);
    fireEvent.change(textarea, { target: { value: "{ bad" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!);
    expect(onLaunch).not.toHaveBeenCalled();
  });
});

// ── 6. Launch call ────────────────────────────────────────────────────────────

describe("Launch confirmation", () => {
  it("calls onLaunch with definitionId and undefined payload when textarea is empty", () => {
    const { onLaunch } = renderDrawer(buildDef());
    fireEvent.click(screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!);
    expect(onLaunch).toHaveBeenCalledWith("def-1", undefined);
  });

  it("calls onLaunch with parsed JSON payload when textarea has valid JSON", () => {
    const { onLaunch } = renderDrawer(buildDef());
    const textarea = screen.getByLabelText(/input payload/i);
    fireEvent.change(textarea, { target: { value: '{"env":"staging"}' } });
    fireEvent.click(screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!);
    expect(onLaunch).toHaveBeenCalledWith("def-1", { env: "staging" });
  });

  it("Cancel button calls onClose without launching", () => {
    const { onLaunch, onClose } = renderDrawer(buildDef());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onLaunch).not.toHaveBeenCalled();
  });
});

// ── 7. Post-launch success state ──────────────────────────────────────────────

describe("Post-launch success state", () => {
  const run = buildRun();
  const def = buildDef();

  it("shows 'Run started' heading in success state", () => {
    renderDrawer(def, { launchResult: run });
    expect(screen.getByText("Run started")).toBeInTheDocument();
  });

  it("shows the definition name in success state", () => {
    renderDrawer(def, { launchResult: run });
    expect(screen.getByText("Daily Report")).toBeInTheDocument();
  });

  it("shows the launched run id in success state", () => {
    renderDrawer(def, { launchResult: run });
    expect(screen.getByText("run-xyz-1")).toBeInTheDocument();
  });

  it("'View run' button calls onViewRun with the run and then onClose", () => {
    const { onViewRun, onClose } = renderDrawer(def, { launchResult: run });
    fireEvent.click(screen.getByRole("button", { name: "View run" }));
    expect(onViewRun).toHaveBeenCalledWith(run);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Close button calls onClose in success state", () => {
    const { onClose } = renderDrawer(def, { launchResult: run });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
