import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { WorkflowDefinitionDrawer } from "./WorkflowDefinitionDrawer";
import type { WorkflowDefinition } from "../../types/workflows";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id:           "def-1",
    name:         "My Workflow",
    description:  "Does the thing",
    workflowType: "report",
    triggerMode:  "manual",
    approvalMode: "none",
    status:       "active",
    entrypoint:   "MY_WORKFLOW",
    enabled:      true,
    tags:         [],
    runCount:     0,
    createdAt:    "2025-01-01T00:00:00Z",
    updatedAt:    "2025-01-02T00:00:00Z",
    ...overrides,
  };
}

/** Render the drawer in create mode (definition=null). */
function renderCreate(props: { onSave?: () => void; onClose?: () => void } = {}) {
  const onSave  = props.onSave  ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <WorkflowDefinitionDrawer
      definition={null}
      saving={false}
      onSave={onSave}
      onClose={onClose}
    />
  );
  return { onSave, onClose };
}

/** Render the drawer in edit mode (definition=WorkflowDefinition). */
function renderEdit(
  def: WorkflowDefinition,
  props: { onSave?: () => void; onClose?: () => void } = {},
) {
  const onSave  = props.onSave  ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <WorkflowDefinitionDrawer
      definition={def}
      saving={false}
      onSave={onSave}
      onClose={onClose}
    />
  );
  return { onSave, onClose };
}

// ── 1. Create vs. edit mode ───────────────────────────────────────────────────

describe("Create vs. edit mode", () => {
  it("create mode shows 'New workflow definition' heading and 'Create definition' submit button", () => {
    renderCreate();
    expect(screen.getByRole("heading", { name: "New workflow definition" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create definition" })).toBeInTheDocument();
  });

  it("edit mode shows 'Edit definition' heading and 'Save changes' submit button", () => {
    renderEdit(buildDef());
    expect(screen.getByRole("heading", { name: "Edit definition" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("edit mode pre-fills the Name field with the definition's current name", () => {
    renderEdit(buildDef({ name: "Pre-filled Name" }));
    expect(screen.getByDisplayValue("Pre-filled Name")).toBeInTheDocument();
  });

  it("edit mode pre-fills the Entrypoint field", () => {
    renderEdit(buildDef({ entrypoint: "PREFILLED_ENTRYPOINT" }));
    expect(screen.getByDisplayValue("PREFILLED_ENTRYPOINT")).toBeInTheDocument();
  });

  it("edit mode shows the definition ID in the Advanced section", () => {
    renderEdit(buildDef({ id: "def-abc-123" }));
    expect(screen.getByText("def-abc-123")).toBeInTheDocument();
  });

  it("create mode shows 'Assigned on creation' placeholder for the ID", () => {
    renderCreate();
    expect(screen.getByText("Assigned on creation")).toBeInTheDocument();
  });

  it("onSave is called with null id in create mode when form is valid", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),       { target: { value: "My New Workflow" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i), { target: { value: "MY_NEW_WORKFLOW" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(onSave).toHaveBeenCalledWith(null, expect.objectContaining({ name: "My New Workflow" }));
  });

  it("onSave is called with the definition id in edit mode", () => {
    const { onSave } = renderEdit(buildDef({ id: "def-xyz" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith("def-xyz", expect.any(Object));
  });

  it("closed state (definition=undefined) renders nothing", () => {
    render(
      <WorkflowDefinitionDrawer
        definition={undefined}
        saving={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

// ── 2. Form validation ────────────────────────────────────────────────────────

describe("Form validation", () => {
  it("submitting an empty form shows required-field errors and the error summary", () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(screen.getByText("Name is required.")).toBeInTheDocument();
    expect(screen.getByText("Entrypoint is required.")).toBeInTheDocument();
    // Footer summary badge
    expect(screen.getByRole("alert")).toHaveTextContent(/fix \d+ error/i);
  });

  it("onSave is NOT called when required fields are empty", () => {
    const { onSave } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("filling both required fields removes all errors on submit", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),       { target: { value: "Good Name" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i), { target: { value: "GOOD_ENTRYPOINT" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("entrypoint with invalid characters shows a binding-name format error", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),       { target: { value: "Valid Name" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i), { target: { value: "invalid-binding!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(
      screen.getByText("Must be a valid binding name (letters, digits, underscores).")
    ).toBeInTheDocument();
  });

  it("invalid JSON in the Input schema field shows a JSON error", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),         { target: { value: "Valid Name" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i),   { target: { value: "VALID" } });
    fireEvent.change(screen.getByLabelText(/^input schema/i), { target: { value: "{ bad json" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(screen.getByText("Must be valid JSON.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("valid JSON in the Input schema field does not produce an error", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),         { target: { value: "Valid Name" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i),   { target: { value: "VALID" } });
    fireEvent.change(screen.getByLabelText(/^input schema/i), { target: { value: '{"type":"object"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(screen.queryByText("Must be valid JSON.")).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("invalid JSON in the Example payload field shows a JSON error", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),              { target: { value: "Valid Name" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i),        { target: { value: "VALID" } });
    fireEvent.change(screen.getByLabelText(/^example payload/i),   { target: { value: "not-json" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(screen.getByText("Must be valid JSON.")).toBeInTheDocument();
  });

  it("no validation errors are shown before the user attempts to submit", () => {
    renderCreate();
    // The alert-role summary badge only appears after the first submit attempt.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Field-level error spans are absent too — checking for the exact error text.
    expect(screen.queryByText("Name is required.")).not.toBeInTheDocument();
    expect(screen.queryByText("Entrypoint is required.")).not.toBeInTheDocument();
  });

  it("error count in the summary matches the number of invalid fields", () => {
    renderCreate();
    // Submit without filling Name or Entrypoint → 2 errors
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Fix 2 errors above");
  });
});

// ── 3. Live preview card ──────────────────────────────────────────────────────

describe("Live preview card", () => {
  it("shows 'Untitled workflow' placeholder when Name is empty", () => {
    renderCreate();
    expect(screen.getByText("Untitled workflow")).toBeInTheDocument();
  });

  it("shows the typed name in the preview card as the user types", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "My Pipeline" } });
    // The preview card renders the name — there may be multiple occurrences
    // (the name in the preview and the placeholder disappears)
    expect(screen.queryByText("Untitled workflow")).not.toBeInTheDocument();
    expect(screen.getAllByText("My Pipeline").length).toBeGreaterThan(0);
  });

  it("shows the 'Enabled' chip in the preview when the definition is enabled", () => {
    renderCreate();
    // "Enabled" appears in both the toggle label and the live preview card.
    expect(screen.getAllByText("Enabled").length).toBeGreaterThan(0);
  });

  it("toggling the enabled switch updates the chip label to 'Disabled'", () => {
    renderCreate();
    // The enabled switch is role="switch"
    fireEvent.click(screen.getByRole("switch"));
    // "Disabled" appears in both the toggle label and the live preview card.
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
  });
});

// ── 4. Launch behavior note ───────────────────────────────────────────────────

describe("Launch behavior note", () => {
  it("manual trigger / no approval shows the expected behavior note", () => {
    renderCreate();
    // Default: manual trigger, none approval
    expect(screen.getByText(/runs are started on demand/i)).toBeInTheDocument();
    expect(screen.getByText(/begin executing immediately/i)).toBeInTheDocument();
  });

  it("changing trigger mode to 'scheduled' updates the behavior note", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^trigger mode/i), { target: { value: "scheduled" } });
    expect(screen.getByText(/runs start automatically on a schedule/i)).toBeInTheDocument();
  });

  it("changing approval mode to 'required' updates the behavior note", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^approval mode/i), { target: { value: "required" } });
    expect(screen.getByText(/wait for reviewer approval/i)).toBeInTheDocument();
  });

  it("event trigger / checkpoint approval shows the combined note", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^trigger mode/i),  { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText(/^approval mode/i), { target: { value: "checkpoint" } });
    expect(screen.getByText(/trigger event is received/i)).toBeInTheDocument();
    expect(screen.getByText(/pause at checkpoints/i)).toBeInTheDocument();
  });
});

// ── 5. Drawer close behaviour ─────────────────────────────────────────────────

describe("Drawer close behaviour", () => {
  it("clicking the Cancel button calls onClose", () => {
    const { onClose } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the ✕ close button calls onClose", () => {
    const { onClose } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel does not call onSave", () => {
    const { onSave } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ── 6. Payload passthrough ────────────────────────────────────────────────────

describe("Payload passthrough", () => {
  it("submitting with tags sends them as an array", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),       { target: { value: "Tagged Workflow" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i), { target: { value: "TAGGED" } });
    fireEvent.change(screen.getByLabelText(/^tags/i),       { target: { value: "nightly, batch, etl" } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(onSave).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ tags: ["nightly", "batch", "etl"] })
    );
  });

  it("submitting with a description sends it in the payload", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^name/i),        { target: { value: "Described Workflow" } });
    fireEvent.change(screen.getByLabelText(/^entrypoint/i),  { target: { value: "DESC_WORKFLOW" } });
    fireEvent.change(screen.getByLabelText(/^description/i), { target: { value: "Detailed description here." } });
    fireEvent.click(screen.getByRole("button", { name: "Create definition" }));

    expect(onSave).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ description: "Detailed description here." })
    );
  });
});
