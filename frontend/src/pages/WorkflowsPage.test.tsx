import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// vi.mock is hoisted before imports — the factory runs first.
vi.mock("../lib/workflowsApi", () => ({
  getWorkflowDefinitions:   vi.fn(),
  createWorkflowDefinition: vi.fn(),
  updateWorkflowDefinition: vi.fn(),
  deleteWorkflowDefinition: vi.fn(),
  toggleWorkflowDefinition: vi.fn(),
  launchWorkflow:           vi.fn(),
  getWorkflowRuns:          vi.fn(),
  terminateWorkflowRun:     vi.fn(),
  approveWorkflowRun:       vi.fn(),
  rejectWorkflowRun:        vi.fn(),
  resumeWorkflowRun:        vi.fn(),
  restartWorkflowRun:       vi.fn(),
  // Returns a fixed list so tests see the dropdown pre-populated.
  fetchWorkflowBindings:    vi.fn().mockResolvedValue(["EDGECLAW_PAGE_INTEL_WORKFLOW", "EDGECLAW_RESEARCH_WORKFLOW"]),
}));

// Suppress the live-update client so it doesn't start real intervals/EventSource.
vi.mock("../lib/workflowRunUpdates", () => ({
  createRunLiveClient:     vi.fn(() => ({ close: vi.fn(), state: "disconnected" })),
  createMockRunLiveClient: vi.fn(() => ({ close: vi.fn(), state: "connected" })),
}));

import {
  getWorkflowDefinitions,
  createWorkflowDefinition,
  updateWorkflowDefinition,
  deleteWorkflowDefinition,
  toggleWorkflowDefinition,
  launchWorkflow,
  getWorkflowRuns,
  terminateWorkflowRun,
  approveWorkflowRun,
  rejectWorkflowRun,
  resumeWorkflowRun,
  restartWorkflowRun,
} from "../lib/workflowsApi";
import { WorkflowsPage } from "./WorkflowsPage";
import type { WorkflowDefinition, WorkflowRun } from "../types/workflows";

afterEach(cleanup);

// Clear mock call history and implementations between tests so counts don't
// bleed across the describe block boundary.
beforeEach(() => vi.clearAllMocks());

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
    runCount:     0,
    createdAt:    "2025-01-01T00:00:00Z",
    updatedAt:    "2025-01-02T00:00:00Z",
    ...overrides,
  };
}

function buildRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id:                   "run-abc-1",
    workflowDefinitionId: "def-1",
    workflowName:         "Daily Report",
    status:               "complete",
    startedAt:            "2025-01-03T09:00:00Z",
    updatedAt:            "2025-01-03T09:05:00Z",
    completedAt:          "2025-01-03T09:05:00Z",
    waitingForApproval:   false,
    ...overrides,
  };
}

/**
 * Renders <WorkflowsPage /> and waits for the initial definitions fetch to
 * settle (the loading skeleton table is no longer in the DOM).
 */
async function renderPage(
  defs: WorkflowDefinition[] = [],
  runs: WorkflowRun[] = [],
) {
  (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: defs, total: defs.length });
  (getWorkflowRuns        as Mock).mockResolvedValue({ runs,          total: runs.length });
  render(<WorkflowsPage />);
  await waitFor(() =>
    expect(screen.queryByRole("table", { name: "Definitions loading" })).not.toBeInTheDocument()
  );
}

/**
 * Clicks the Runs tab and waits for any remaining loading state to resolve.
 * Both fetches start concurrently; by the time renderPage resolves, runs are
 * already available, so this typically resolves immediately.
 */
async function goToRunsTab() {
  fireEvent.click(screen.getByRole("tab", { name: /runs/i }));
  await waitFor(() =>
    expect(screen.queryByRole("table", { name: "Runs loading" })).not.toBeInTheDocument()
  );
}

// ── 1. Definitions list rendering ─────────────────────────────────────────────

describe("Definitions list rendering", () => {
  it("shows the definitions loading skeleton while fetching", async () => {
    (getWorkflowDefinitions as Mock).mockReturnValue(new Promise(() => {}));
    (getWorkflowRuns        as Mock).mockReturnValue(new Promise(() => {}));
    render(<WorkflowsPage />);
    expect(
      await screen.findByRole("table", { name: "Definitions loading" })
    ).toBeInTheDocument();
  });

  it("displays definition name and description after data loads", async () => {
    await renderPage([buildDef()]);
    expect(screen.getByText("Daily Report")).toBeInTheDocument();
    expect(screen.getByText("Builds the daily report")).toBeInTheDocument();
  });

  it("displays multiple definitions as separate rows", async () => {
    await renderPage([
      buildDef({ id: "d1", name: "Alpha Workflow" }),
      buildDef({ id: "d2", name: "Beta Workflow"  }),
    ]);
    expect(screen.getByText("Alpha Workflow")).toBeInTheDocument();
    expect(screen.getByText("Beta Workflow")).toBeInTheDocument();
  });

  it("shows 'No workflow definitions yet' empty state when the list is empty", async () => {
    await renderPage([]);
    expect(screen.getByText("No workflow definitions yet")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /\+ new definition/i }).length
    ).toBeGreaterThan(0);
  });

  it("shows 'No matching definitions' when every definition is filtered out", async () => {
    await renderPage([buildDef()]);
    fireEvent.change(screen.getByLabelText("Search workflow definitions"), {
      target: { value: "zzznomatch" },
    });
    expect(screen.getByText("No matching definitions")).toBeInTheDocument();
  });

  it("renders the stats bar with correct total count", async () => {
    await renderPage(
      [buildDef({ id: "d1", enabled: true }), buildDef({ id: "d2", enabled: false })],
      [buildRun({ status: "running" })],
    );
    const statsBar = screen.getByLabelText("Workflow overview");
    expect(statsBar).toHaveTextContent("2");   // Definitions card
    expect(statsBar).toHaveTextContent("1");   // Active runs card
  });

  it("shows an error banner when the definitions fetch fails", async () => {
    (getWorkflowDefinitions as Mock).mockRejectedValue(new Error("Server error"));
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [], total: 0 });
    render(<WorkflowsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Server error");
  });
});

// ── 2. Runs list rendering ────────────────────────────────────────────────────

describe("Runs list rendering", () => {
  it("shows run workflow name and truncated ID after switching to the Runs tab", async () => {
    await renderPage([], [buildRun({ id: "run-abc-1", workflowName: "Daily Report" })]);
    await goToRunsTab();
    // The workflow name appears both in the table row and as a dropdown <option>
    // in the RunsToolbar — use getAllByText to handle both occurrences.
    expect(screen.getAllByText("Daily Report").length).toBeGreaterThan(0);
    expect(screen.getByText("run-abc-1")).toBeInTheDocument();
  });

  it("shows the runs loading skeleton while fetching", async () => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns        as Mock).mockReturnValue(new Promise(() => {}));
    render(<WorkflowsPage />);
    // Defs load (empty); switch to Runs tab while runs are still loading
    await waitFor(() =>
      expect(screen.queryByRole("table", { name: "Definitions loading" })).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("tab", { name: /runs/i }));
    expect(
      await screen.findByRole("table", { name: "Runs loading" })
    ).toBeInTheDocument();
  });

  it("shows 'No runs yet' empty state when no runs have been created", async () => {
    await renderPage([], []);
    await goToRunsTab();
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("shows 'No matching runs' when all runs are filtered out by search", async () => {
    await renderPage([], [buildRun()]);
    await goToRunsTab();
    fireEvent.change(screen.getByLabelText("Search workflow runs"), {
      target: { value: "zzznomatch" },
    });
    expect(screen.getByText("No matching runs")).toBeInTheDocument();
  });
});

// ── 3. Search and filtering — Definitions tab ─────────────────────────────────

describe("Search and filtering — Definitions tab", () => {
  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({
      definitions: [
        buildDef({ id: "d1", name: "Alpha Pipeline",  triggerMode: "manual",    status: "active",   enabled: true  }),
        buildDef({ id: "d2", name: "Beta Report",     triggerMode: "scheduled", status: "draft",    enabled: false }),
        buildDef({ id: "d3", name: "Gamma Approval",  triggerMode: "event",     status: "archived", enabled: true  }),
      ],
      total: 3,
    });
    (getWorkflowRuns as Mock).mockResolvedValue({ runs: [], total: 0 });
  });

  it("searching by name hides non-matching definitions", async () => {
    render(<WorkflowsPage />);
    await screen.findByText("Alpha Pipeline");

    fireEvent.change(screen.getByLabelText("Search workflow definitions"), {
      target: { value: "beta" },
    });

    expect(screen.getByText("Beta Report")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Pipeline")).not.toBeInTheDocument();
    expect(screen.queryByText("Gamma Approval")).not.toBeInTheDocument();
  });

  it("filter by enabled state 'enabled' shows only enabled definitions", async () => {
    render(<WorkflowsPage />);
    await screen.findByText("Alpha Pipeline");

    fireEvent.change(screen.getByLabelText("Filter by enabled state"), {
      target: { value: "enabled" },
    });

    expect(screen.getByText("Alpha Pipeline")).toBeInTheDocument();
    expect(screen.getByText("Gamma Approval")).toBeInTheDocument();
    expect(screen.queryByText("Beta Report")).not.toBeInTheDocument();
  });

  it("filter by trigger mode 'scheduled' shows only scheduled definitions", async () => {
    render(<WorkflowsPage />);
    await screen.findByText("Alpha Pipeline");

    fireEvent.change(screen.getByLabelText("Filter by trigger mode"), {
      target: { value: "scheduled" },
    });

    expect(screen.getByText("Beta Report")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Pipeline")).not.toBeInTheDocument();
    expect(screen.queryByText("Gamma Approval")).not.toBeInTheDocument();
  });

  it("filter by definition status 'draft' shows only draft definitions", async () => {
    render(<WorkflowsPage />);
    await screen.findByText("Alpha Pipeline");

    fireEvent.change(screen.getByLabelText("Filter by definition status"), {
      target: { value: "draft" },
    });

    expect(screen.getByText("Beta Report")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Pipeline")).not.toBeInTheDocument();
    expect(screen.queryByText("Gamma Approval")).not.toBeInTheDocument();
  });

  it("shows 'No matching definitions' when all definitions are filtered out", async () => {
    render(<WorkflowsPage />);
    await screen.findByText("Alpha Pipeline");

    fireEvent.change(screen.getByLabelText("Search workflow definitions"), {
      target: { value: "zzznomatch" },
    });

    expect(screen.getByText("No matching definitions")).toBeInTheDocument();
  });

  it("'Clear' button in the toolbar resets all filters and restores all rows", async () => {
    render(<WorkflowsPage />);
    await screen.findByText("Alpha Pipeline");

    fireEvent.change(screen.getByLabelText("Search workflow definitions"), {
      target: { value: "zzznomatch" },
    });
    expect(screen.getByText("No matching definitions")).toBeInTheDocument();

    // The toolbar "Clear" button appears only when at least one filter is active.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByText("Alpha Pipeline")).toBeInTheDocument();
    expect(screen.getByText("Beta Report")).toBeInTheDocument();
    expect(screen.getByText("Gamma Approval")).toBeInTheDocument();
  });
});

// ── 4. Search and filtering — Runs tab ────────────────────────────────────────

describe("Search and filtering — Runs tab", () => {
  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns as Mock).mockResolvedValue({
      runs: [
        buildRun({ id: "r1", workflowName: "Alpha Report",  status: "running"  }),
        buildRun({ id: "r2", workflowName: "Beta Pipeline", status: "complete" }),
        buildRun({ id: "r3", workflowName: "Gamma Job",     status: "errored"  }),
      ],
      total: 3,
    });
  });

  it("searching by workflow name narrows the runs list", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();

    fireEvent.change(screen.getByLabelText("Search workflow runs"), {
      target: { value: "beta" },
    });

    // After filtering to "beta", only 1 of 3 runs is visible → 1 View button in the table.
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(1);
  });

  it("filter by run status 'errored' shows only errored runs", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();

    fireEvent.change(screen.getByLabelText("Filter by run status"), {
      target: { value: "errored" },
    });

    // 1 of 3 runs is errored → 1 View button remains
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(1);
  });

  it("approval filter 'pending' shows only runs waiting for approval", async () => {
    (getWorkflowRuns as Mock).mockResolvedValue({
      runs: [
        buildRun({ id: "r1", workflowName: "Needs Approval", status: "waiting", waitingForApproval: true  }),
        buildRun({ id: "r2", workflowName: "No Approval",    status: "running",  waitingForApproval: false }),
      ],
      total: 2,
    });
    render(<WorkflowsPage />);
    await goToRunsTab();

    fireEvent.change(screen.getByLabelText("Filter by approval state"), {
      target: { value: "pending" },
    });

    // 1 of 2 runs is pending approval → 1 View button and Approve/Reject buttons visible
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Approve" }).length).toBeGreaterThan(0);
  });
});

// ── 5. Create definition flow ─────────────────────────────────────────────────

describe("Create definition flow", () => {
  const createdDef = buildDef({ id: "def-new", name: "New Automation", entrypoint: "NEW_AUTOMATION" });

  beforeEach(() => {
    (getWorkflowDefinitions  as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns         as Mock).mockResolvedValue({ runs: [], total: 0 });
    (createWorkflowDefinition as Mock).mockResolvedValue(createdDef);
  });

  it("clicking '+ New definition' opens the create drawer", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new definition/i })[0]);
    expect(screen.getByRole("heading", { name: "New workflow definition" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create definition" })).toBeInTheDocument();
  });

  it("submitting a valid form calls createWorkflowDefinition with the correct data", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new definition/i })[0]);

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "New Automation" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i), { target: { value: "NEW_AUTOMATION" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    await waitFor(() => expect(createWorkflowDefinition).toHaveBeenCalledTimes(1));
    expect(createWorkflowDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New Automation", entrypoint: "NEW_AUTOMATION" })
    );
  });

  it("shows 'Definition created.' success banner after creation", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new definition/i })[0]);
    fireEvent.change(screen.getByLabelText(/^name/i),       { target: { value: "New Automation" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i), { target: { value: "NEW_AUTOMATION" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    await screen.findByText("Definition created.");
  });

  it("newly created definition appears in the list after creation", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new definition/i })[0]);
    fireEvent.change(screen.getByLabelText(/^name/i),       { target: { value: "New Automation" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i), { target: { value: "NEW_AUTOMATION" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    await screen.findByText("New Automation");
  });

  it("Cancel closes the drawer without calling createWorkflowDefinition", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new definition/i })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(createWorkflowDefinition).not.toHaveBeenCalled();
    // Drawer is gone
    expect(screen.queryByRole("heading", { name: "New workflow definition" })).not.toBeInTheDocument();
  });
});

// ── 6. Edit definition flow ───────────────────────────────────────────────────

describe("Edit definition flow", () => {
  const original = buildDef({ id: "def-edit", name: "Original Name" });
  const updated  = buildDef({ id: "def-edit", name: "Updated Name" });

  beforeEach(() => {
    (getWorkflowDefinitions  as Mock).mockResolvedValue({ definitions: [original], total: 1 });
    (getWorkflowRuns         as Mock).mockResolvedValue({ runs: [], total: 0 });
    (updateWorkflowDefinition as Mock).mockResolvedValue(updated);
  });

  it("clicking the Edit button opens the drawer with existing data pre-filled", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("heading", { name: "Edit definition" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Original Name")).toBeInTheDocument();
  });

  it("clicking the definition title button also opens the edit drawer", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: /original name/i }));
    expect(screen.getByRole("heading", { name: "Edit definition" })).toBeInTheDocument();
  });

  it("saving calls updateWorkflowDefinition with the definition id and updated values", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.change(screen.getByDisplayValue("Original Name"), {
      target: { value: "Updated Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateWorkflowDefinition).toHaveBeenCalledTimes(1));
    expect(updateWorkflowDefinition).toHaveBeenCalledWith(
      "def-edit",
      expect.objectContaining({ name: "Updated Name" })
    );
  });

  it("shows 'Definition updated.' success banner after saving", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Original Name"), { target: { value: "Updated Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Definition updated.");
  });

  it("updated name is reflected in the definitions list", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Original Name"), { target: { value: "Updated Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Updated Name");
    expect(screen.queryByText("Original Name")).not.toBeInTheDocument();
  });
});

// ── 7. Delete definition flow ─────────────────────────────────────────────────

describe("Delete definition flow", () => {
  const def = buildDef({ id: "def-del", name: "Definition to Delete" });

  beforeEach(() => {
    (getWorkflowDefinitions  as Mock).mockResolvedValue({ definitions: [def], total: 1 });
    (getWorkflowRuns         as Mock).mockResolvedValue({ runs: [], total: 0 });
    (deleteWorkflowDefinition as Mock).mockResolvedValue(undefined);
  });

  it("clicking Delete shows a confirmation dialog", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Delete definition?")).toBeInTheDocument();
  });

  it("cancelling the dialog does not call deleteWorkflowDefinition", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteWorkflowDefinition).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirming calls deleteWorkflowDefinition with the correct definition id", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete definition" }));

    await waitFor(() => expect(deleteWorkflowDefinition).toHaveBeenCalledWith("def-del"));
  });

  it("definition is removed from the list after successful deletion", async () => {
    await renderPage([def]);
    expect(screen.getByText("Definition to Delete")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete definition" }));

    await waitFor(() =>
      expect(screen.queryByText("Definition to Delete")).not.toBeInTheDocument()
    );
  });

  it("shows 'Definition deleted.' success banner after deletion", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete definition" }));

    await screen.findByText("Definition deleted.");
  });
});

// ── 8. Launch workflow flow (via launch drawer) ───────────────────────────────

describe("Launch workflow flow", () => {
  const def = buildDef({ id: "def-launch", name: "Pipeline A", status: "active", enabled: true });
  const launchedRun = buildRun({ id: "run-new", workflowName: "Pipeline A", status: "running" });

  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [def], total: 1 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [], total: 0 });
    (launchWorkflow         as Mock).mockResolvedValue(launchedRun);
  });

  it("clicking Launch opens the launch drawer", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(screen.getByLabelText("Launch Pipeline A")).toBeInTheDocument();
  });

  it("confirming launch in the drawer calls launchWorkflow with the definition id", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    // Click the Launch confirm button inside the drawer.
    const confirmBtn = screen.getAllByRole("button", { name: "Launch" })[1] ??
                       screen.getAllByRole("button", { name: /^launch$/i }).at(-1);
    fireEvent.click(confirmBtn!);
    await waitFor(() => expect(launchWorkflow).toHaveBeenCalledWith("def-launch", undefined));
  });

  it("shows a success banner mentioning the definition name after a successful launch", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    const confirmBtn = screen.getAllByRole("button", { name: /^launch$/i }).at(-1);
    fireEvent.click(confirmBtn!);
    // Banner format: `Launched "${name}" — run ${id.slice(0,8)}…`
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/launched "Pipeline A"/i)
    );
  });

  it("shows an error banner when launch fails", async () => {
    (launchWorkflow as Mock).mockRejectedValue(new Error("Binding not found"));
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    const confirmBtn = screen.getAllByRole("button", { name: /^launch$/i }).at(-1);
    fireEvent.click(confirmBtn!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Binding not found");
  });

  it("Launch button is disabled when the definition is disabled", async () => {
    const disabledDef = buildDef({ id: "def-dis", enabled: false, status: "active" });
    await renderPage([disabledDef]);
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("confirming launch with a JSON payload passes parsed input to launchWorkflow", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    // Type a valid JSON object into the payload textarea.
    const textarea = screen.getByLabelText(/input payload/i);
    fireEvent.change(textarea, { target: { value: '{"region":"us-east-1"}' } });

    const confirmBtn = screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!;
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(launchWorkflow).toHaveBeenCalledWith("def-launch", { input: { region: "us-east-1" } })
    );
  });

  it("clicking 'View run' in the success state switches to the Runs tab and opens the inspector", async () => {
    await renderPage([def]);

    // Open launch drawer and confirm.
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    const confirmBtn = screen.getAllByRole("button", { name: /^launch$/i }).at(-1)!;
    fireEvent.click(confirmBtn);

    // Wait for the success state to appear (drawer shows "Run started").
    await screen.findByText("Run started");

    // Click "View run" — this should close the drawer, switch to Runs tab, and
    // open the run inspector for the newly launched run.
    fireEvent.click(screen.getByRole("button", { name: "View run" }));

    // Runs tab should be active.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /runs/i })).toHaveAttribute("aria-selected", "true")
    );

    // The run inspector should be open showing the launched run's workflow name.
    expect(screen.getByLabelText("Run inspector")).toBeInTheDocument();
    expect(screen.getAllByText("Pipeline A").length).toBeGreaterThan(0);
  });
});

// ── 9. Enable / disable toggle ────────────────────────────────────────────────

describe("Enable / disable toggle", () => {
  it("toggling an enabled definition calls toggleWorkflowDefinition with enabled=false", async () => {
    const def = buildDef({ id: "def-t1", enabled: true });
    (getWorkflowDefinitions  as Mock).mockResolvedValue({ definitions: [def], total: 1 });
    (getWorkflowRuns         as Mock).mockResolvedValue({ runs: [], total: 0 });
    (toggleWorkflowDefinition as Mock).mockResolvedValue({ ...def, enabled: false });

    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    await waitFor(() => expect(toggleWorkflowDefinition).toHaveBeenCalledWith("def-t1", false));
  });

  it("toggling a disabled definition calls toggleWorkflowDefinition with enabled=true", async () => {
    const def = buildDef({ id: "def-t2", enabled: false });
    (getWorkflowDefinitions  as Mock).mockResolvedValue({ definitions: [def], total: 1 });
    (getWorkflowRuns         as Mock).mockResolvedValue({ runs: [], total: 0 });
    (toggleWorkflowDefinition as Mock).mockResolvedValue({ ...def, enabled: true, status: "active" });

    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Disabled" }));
    await waitFor(() => expect(toggleWorkflowDefinition).toHaveBeenCalledWith("def-t2", true));
  });

  it("enabled toggle button carries aria-pressed=true", async () => {
    const def = buildDef({ id: "def-t3", enabled: true });
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [def], total: 1 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [], total: 0 });

    await renderPage([def]);
    expect(screen.getByRole("button", { name: "Enabled" })).toHaveAttribute("aria-pressed", "true");
  });
});

// ── 10. Run approval actions ──────────────────────────────────────────────────

describe("Run approval actions", () => {
  const waitingRun = buildRun({
    id:                 "run-w1",
    workflowName:       "Approval Workflow",
    status:             "waiting",
    waitingForApproval: true,
  });

  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [waitingRun], total: 1 });
    (approveWorkflowRun     as Mock).mockResolvedValue({ ...waitingRun, status: "running",    waitingForApproval: false });
    (rejectWorkflowRun      as Mock).mockResolvedValue({ ...waitingRun, status: "terminated", waitingForApproval: false });
  });

  it("Approve button in the runs table calls approveWorkflowRun with the run id and no approval data", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approveWorkflowRun).toHaveBeenCalledWith("run-w1", undefined));
  });

  it("Reject button in the runs table calls rejectWorkflowRun with the run id and no approval data", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(rejectWorkflowRun).toHaveBeenCalledWith("run-w1", undefined));
  });

  it("shows a success banner after approving a run", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Run approved — continuing execution.");
  });

  it("shows a banner after rejecting a run", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    // Rejection is treated as an error-kind banner (role="alert")
    await screen.findByText("Run rejected and terminated.");
  });
});

// ── 11. Terminate / resume / restart actions ──────────────────────────────────

describe("Terminate / resume / restart actions", () => {
  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
  });

  it("Terminate button calls terminateWorkflowRun for a running run", async () => {
    const run = buildRun({ id: "run-r1", status: "running", waitingForApproval: false });
    (getWorkflowRuns     as Mock).mockResolvedValue({ runs: [run], total: 1 });
    (terminateWorkflowRun as Mock).mockResolvedValue({ ...run, status: "terminated" });

    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    await waitFor(() => expect(terminateWorkflowRun).toHaveBeenCalledWith("run-r1"));
  });

  it("Resume button calls resumeWorkflowRun for a paused run", async () => {
    const run = buildRun({ id: "run-p1", status: "paused" });
    (getWorkflowRuns   as Mock).mockResolvedValue({ runs: [run], total: 1 });
    (resumeWorkflowRun as Mock).mockResolvedValue({ ...run, status: "running" });

    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeWorkflowRun).toHaveBeenCalledWith("run-p1"));
  });

  it("Restart button calls restartWorkflowRun for a completed run", async () => {
    const run = buildRun({ id: "run-c1", status: "complete" });
    (getWorkflowRuns    as Mock).mockResolvedValue({ runs: [run], total: 1 });
    (restartWorkflowRun as Mock).mockResolvedValue({ ...run, status: "running" });

    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(restartWorkflowRun).toHaveBeenCalledWith("run-c1"));
  });

  it("shows a success banner after terminating a run", async () => {
    const run = buildRun({ id: "run-r2", status: "running", waitingForApproval: false });
    (getWorkflowRuns     as Mock).mockResolvedValue({ runs: [run], total: 1 });
    (terminateWorkflowRun as Mock).mockResolvedValue({ ...run, status: "terminated" });

    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    await screen.findByText("Run terminated.");
  });
});

// ── 12. Run inspector drawer ──────────────────────────────────────────────────

describe("Run inspector drawer", () => {
  const completeRun = buildRun({
    id:              "run-inspect-1",
    workflowName:    "Inspect Me",
    status:          "complete",
    resultSummary:   "Processed 100 rows successfully.",
    progressPercent: 100,
  });

  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [completeRun], total: 1 });
  });

  it("clicking View opens the inspector showing the workflow name", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    // The drawer header renders the workflow name as a heading
    expect(screen.getAllByText("Inspect Me").length).toBeGreaterThan(0);
  });

  it("the inspector shows the result summary for a completed run", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("Processed 100 rows successfully.")).toBeInTheDocument();
  });

  it("the inspector shows 'Approve run' / 'Reject run' callout when the run is waiting for approval", async () => {
    const waitingRun = buildRun({
      id:                 "run-w2",
      workflowName:       "Approval Flow",
      status:             "waiting",
      waitingForApproval: true,
    });
    (getWorkflowRuns    as Mock).mockResolvedValue({ runs: [waitingRun], total: 1 });
    (approveWorkflowRun as Mock).mockResolvedValue({ ...waitingRun, status: "running", waitingForApproval: false });

    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(screen.getByRole("button", { name: "Approve run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject run" })).toBeInTheDocument();
  });

  it("closing the inspector via the close button removes it from the DOM", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    fireEvent.click(screen.getByRole("button", { name: "Close run inspector" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Close run inspector" })).not.toBeInTheDocument()
    );
  });
});

// ── Phase 2: Feature 3 — Definition↔Run cross-tab navigation ─────────────────

describe("Definition ↔ Run relationship", () => {
  const def = buildDef({
    id: "def-nav", name: "Nav Pipeline", runCount: 5, lastRunAt: "2025-01-03T08:00:00Z",
  });

  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [def], total: 1 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [], total: 0 });
  });

  it("'Runs' action button appears on each definition row", async () => {
    await renderPage([def]);
    expect(screen.getByRole("button", { name: "Runs" })).toBeInTheDocument();
  });

  it("clicking 'Runs' switches to the Runs tab", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /runs/i })).toHaveAttribute("aria-selected", "true")
    );
  });

  it("run count renders as a button when runCount > 0", async () => {
    await renderPage([def]);
    // The run count button shows "5 runs"
    expect(screen.getByRole("button", { name: /5 runs/i })).toBeInTheDocument();
  });

  it("clicking run count button switches to the Runs tab", async () => {
    await renderPage([def]);
    fireEvent.click(screen.getByRole("button", { name: /5 runs/i }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /runs/i })).toHaveAttribute("aria-selected", "true")
    );
  });
});

// ── Phase 2: Feature 6 — Error visibility in run row ─────────────────────────

describe("Error visibility in run row", () => {
  it("shows an error hint in the title cell when the run is errored and has an errorMessage", async () => {
    const erroredRun = buildRun({
      id:           "run-err",
      status:       "errored",
      errorMessage: "Connection timeout after 30s",
    });
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [erroredRun], total: 1 });

    await renderPage([], [erroredRun]);
    await goToRunsTab();

    expect(screen.getByText("Connection timeout after 30s")).toBeInTheDocument();
  });

  it("does not show an error hint for a successful run", async () => {
    const successRun = buildRun({ status: "complete", errorMessage: undefined });
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [successRun], total: 1 });

    await renderPage([], [successRun]);
    await goToRunsTab();

    expect(screen.queryByTitle(/error/i)).not.toBeInTheDocument();
  });
});

// ── Phase 2: Feature 5 — Approval comment passed through ─────────────────────

describe("Approval with comment (from run inspector)", () => {
  const waitingRun = buildRun({
    id: "run-approval-comment",
    status: "waiting",
    waitingForApproval: true,
    workflowName: "Approval Pipeline",
  });

  beforeEach(() => {
    (getWorkflowDefinitions as Mock).mockResolvedValue({ definitions: [], total: 0 });
    (getWorkflowRuns        as Mock).mockResolvedValue({ runs: [waitingRun], total: 1 });
    (approveWorkflowRun     as Mock).mockResolvedValue({
      ...waitingRun, status: "running", waitingForApproval: false,
    });
  });

  it("approveWorkflowRun is called with a comment object when reviewer enters a comment", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    const textarea = screen.getByPlaceholderText(/add a note/i);
    fireEvent.change(textarea, { target: { value: "Approved by manager" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve run" }));

    await waitFor(() =>
      expect(approveWorkflowRun).toHaveBeenCalledWith(
        "run-approval-comment",
        { comment: "Approved by manager" },
      )
    );
  });

  it("approveWorkflowRun is called without comment data when textarea is empty", async () => {
    render(<WorkflowsPage />);
    await goToRunsTab();
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    fireEvent.click(screen.getByRole("button", { name: "Approve run" }));

    await waitFor(() =>
      expect(approveWorkflowRun).toHaveBeenCalledWith("run-approval-comment", undefined)
    );
  });
});
