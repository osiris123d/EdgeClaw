import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { TaskDrawer } from "./TaskDrawer";
import type { ScheduledTask } from "../../types/tasks";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id:                 "task-1",
    title:              "Standup reminder",
    taskType:           "reminder",
    scheduleType:       "cron",
    scheduleExpression: "0 9 * * 1-5",
    timezone:           "America/Chicago",
    enabled:            true,
    status:             "active",
    instructions:       "Remind the team to start standup.",
    createdAt:          "2025-01-01T00:00:00Z",
    updatedAt:          "2025-01-02T00:00:00Z",
    ...overrides,
  };
}

/** Render the drawer in create mode (task=null). */
function renderCreate(props: { onSave?: () => void; onClose?: () => void } = {}) {
  const onSave  = props.onSave  ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <TaskDrawer task={null} saving={false} onSave={onSave} onClose={onClose} />
  );
  return { onSave, onClose };
}

/** Render the drawer in edit mode. */
function renderEdit(
  task: ScheduledTask,
  props: { onSave?: () => void; onClose?: () => void } = {}
) {
  const onSave  = props.onSave  ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <TaskDrawer task={task} saving={false} onSave={onSave} onClose={onClose} />
  );
  return { onSave, onClose };
}

// ── 1. Schedule summary preview ───────────────────────────────────────────────

describe("Schedule summary preview", () => {
  it("interval schedule shows 'Runs every Xh' preview", () => {
    renderCreate();
    // Default scheduleType is "interval" in create mode.
    fireEvent.change(screen.getByLabelText(/^expression/i), {
      target: { value: "every 6h" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Runs every 6h");
  });

  it("cron schedule with a recognisable pattern shows a friendly description and the raw expression", () => {
    renderCreate();
    fireEvent.change(screen.getByRole("combobox", { name: /schedule type/i }), {
      target: { value: "cron" },
    });
    fireEvent.change(screen.getByLabelText(/^expression/i), {
      target: { value: "0 9 * * 1-5" },
    });
    const status = screen.getByRole("status");
    // Friendly description
    expect(status).toHaveTextContent("Weekdays at 9 AM");
    // Raw expression still present so power users can verify
    expect(status).toHaveTextContent("0 9 * * 1-5");
  });

  it("cron schedule with an unrecognised pattern falls back to raw 'Cron — <expr>'", () => {
    renderCreate();
    fireEvent.change(screen.getByRole("combobox", { name: /schedule type/i }), {
      target: { value: "cron" },
    });
    fireEvent.change(screen.getByLabelText(/^expression/i), {
      target: { value: "30 3 15 * 2" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Cron — 30 3 15 * 2");
  });

  it("once schedule with a valid ISO date shows 'Runs once on ...' preview", () => {
    renderCreate();
    fireEvent.change(screen.getByRole("combobox", { name: /schedule type/i }), {
      target: { value: "once" },
    });
    fireEvent.change(screen.getByLabelText(/^expression/i), {
      target: { value: "2025-06-15T09:00:00Z" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/runs once on/i);
  });

  it("once schedule with an unparseable expression falls back gracefully", () => {
    renderCreate();
    fireEvent.change(screen.getByRole("combobox", { name: /schedule type/i }), {
      target: { value: "once" },
    });
    fireEvent.change(screen.getByLabelText(/^expression/i), {
      target: { value: "not-a-date" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/one-time:/i);
  });

  it("interval preview includes timezone when timezone is filled in", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^expression/i), {
      target: { value: "every 1d" },
    });
    fireEvent.change(screen.getByLabelText(/^timezone/i), {
      target: { value: "America/Chicago" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("America/Chicago");
  });

  it("empty interval expression produces no preview", () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/^expression/i), {
      target: { value: "" },
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

// ── 2. Form validation ────────────────────────────────────────────────────────

describe("Form validation", () => {
  it("submitting an empty form shows required-field errors for all three required fields", () => {
    renderCreate();
    const exprInput = screen.getByLabelText(/^expression/i);
    fireEvent.change(exprInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    const alerts = screen.getAllByRole("alert");
    const alertTexts = alerts.map((a) => a.textContent ?? "");
    expect(alertTexts.some((t) => /title is required/i.test(t))).toBe(true);
    expect(alertTexts.some((t) => /expression is required/i.test(t))).toBe(true);
    expect(alertTexts.some((t) => /instructions are required/i.test(t))).toBe(true);
  });

  it("filling all required fields and submitting shows no validation errors", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^title/i),        { target: { value: "My task" } });
    fireEvent.change(screen.getByLabelText(/^expression/i),   { target: { value: "every 1h" } });
    fireEvent.change(screen.getByLabelText(/^instructions/i), { target: { value: "Do the thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("blurring a required field early shows its error before submit", () => {
    renderCreate();
    const titleInput = screen.getByLabelText(/^title/i);
    fireEvent.blur(titleInput);

    expect(screen.getByRole("alert")).toHaveTextContent(/title is required/i);
  });

  it("title error does not appear before the field is touched", () => {
    renderCreate();
    // No interaction at all — errors must be invisible until the user engages.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("invalid JSON in the payload field shows a JSON error", () => {
    renderCreate();
    // Open the collapsible payload section.
    fireEvent.click(screen.getByRole("button", { name: /payload json/i }));

    const payloadTextarea = screen.getByLabelText("Payload JSON");
    fireEvent.change(payloadTextarea, { target: { value: "{ bad json" } });
    fireEvent.blur(payloadTextarea);

    // Trigger submit so touched+errors are evaluated together.
    fireEvent.change(screen.getByLabelText(/^title/i),        { target: { value: "A title" } });
    fireEvent.change(screen.getByLabelText(/^expression/i),   { target: { value: "every 1h" } });
    fireEvent.change(screen.getByLabelText(/^instructions/i), { target: { value: "Do the thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/must be valid json/i);
  });

  it("valid JSON in the payload field does not show a JSON error", () => {
    const { onSave } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: /payload json/i }));

    fireEvent.change(screen.getByLabelText("Payload JSON"), {
      target: { value: '{"key":"value"}' },
    });
    fireEvent.change(screen.getByLabelText(/^title/i),        { target: { value: "A title" } });
    fireEvent.change(screen.getByLabelText(/^expression/i),   { target: { value: "every 1h" } });
    fireEvent.change(screen.getByLabelText(/^instructions/i), { target: { value: "Do the thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("onSave is not called when validation fails", () => {
    const { onSave } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ── 3. Create vs. edit mode ───────────────────────────────────────────────────

describe("Create vs. edit mode", () => {
  it("create mode shows 'New task' heading and 'Create task' submit button", () => {
    renderCreate();
    expect(screen.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create task" })).toBeInTheDocument();
  });

  it("edit mode shows 'Edit task' heading and 'Save changes' submit button", () => {
    renderEdit(buildTask());
    expect(screen.getByRole("heading", { name: "Edit task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("edit mode pre-fills the title field with the task's current title", () => {
    renderEdit(buildTask({ title: "Pre-existing title" }));
    expect(screen.getByDisplayValue("Pre-existing title")).toBeInTheDocument();
  });

  it("edit mode shows the Advanced section with the task ID", () => {
    renderEdit(buildTask({ id: "task-abc-123" }));
    expect(screen.getByText("Task ID")).toBeInTheDocument();
    expect(screen.getByText("task-abc-123")).toBeInTheDocument();
  });

  it("edit mode does NOT show the Advanced section in create mode", () => {
    renderCreate();
    expect(screen.queryByText("Task ID")).not.toBeInTheDocument();
  });

  it("edit mode pre-fills the schedule expression", () => {
    renderEdit(buildTask({ scheduleExpression: "0 9 * * 1-5" }));
    expect(screen.getByDisplayValue("0 9 * * 1-5")).toBeInTheDocument();
  });

  it("onSave is called with null id in create mode", () => {
    const { onSave } = renderCreate();
    fireEvent.change(screen.getByLabelText(/^title/i),        { target: { value: "A title" } });
    fireEvent.change(screen.getByLabelText(/^expression/i),   { target: { value: "every 1h" } });
    fireEvent.change(screen.getByLabelText(/^instructions/i), { target: { value: "Do it." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(onSave).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it("onSave is called with the task id in edit mode", () => {
    const { onSave } = renderEdit(buildTask({ id: "task-xyz" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith("task-xyz", expect.any(Object));
  });
});

// ── 4. Drawer close behaviour ─────────────────────────────────────────────────

describe("Drawer close behaviour", () => {
  it("clicking the Close button calls onClose", () => {
    const { onClose } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: /close editor/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the Cancel button calls onClose", () => {
    const { onClose } = renderCreate();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key calls onClose when drawer is open", () => {
    const { onClose } = renderCreate();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closed drawer (task=undefined) is aria-hidden", () => {
    render(
      <TaskDrawer task={undefined} saving={false} onSave={vi.fn()} onClose={vi.fn()} />
    );
    // The wrapper div should have aria-hidden="true" when closed.
    const wrapper = document.querySelector(".tasks-drawer-wrap");
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
  });
});
