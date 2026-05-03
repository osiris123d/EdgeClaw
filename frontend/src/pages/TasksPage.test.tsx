import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// vi.mock is hoisted before imports — the factory runs first.
vi.mock("../lib/tasksApi", () => ({
  getTasks:   vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  toggleTask: vi.fn(),
}));

import { getTasks, createTask, updateTask, deleteTask, toggleTask } from "../lib/tasksApi";
import { TasksPage } from "./TasksPage";
import type { ScheduledTask } from "../types/tasks";

afterEach(cleanup);

// Clear mock call history and implementations between tests so counts don't
// bleed across the describe block boundary.
beforeEach(() => vi.clearAllMocks());

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id:                 "task-1",
    title:              "Standup reminder",
    description:        "Ping the team channel",
    taskType:           "reminder",
    scheduleType:       "cron",
    scheduleExpression: "0 9 * * 1-5",
    timezone:           "America/Chicago",
    enabled:            true,
    status:             "active",
    instructions:       "Remind the team to start standup.",
    createdAt:          "2025-01-01T00:00:00Z",
    updatedAt:          "2025-01-02T00:00:00Z",
    lastRunAt:          "2025-01-03T09:00:00Z",
    nextRunAt:          "2025-01-04T09:00:00Z",
    ...overrides,
  };
}

/**
 * Render <TasksPage /> and wait for the initial data-fetch to settle.
 * Returns after the loading skeleton has left the DOM.
 */
async function renderPage(tasks: ScheduledTask[] = []) {
  (getTasks as Mock).mockResolvedValue({ tasks, total: tasks.length });
  render(<TasksPage />);
  // The aria-busy table is present while loading.  Wait for it to leave.
  await waitFor(() =>
    expect(screen.queryByRole("table", { name: "Tasks loading" })).not.toBeInTheDocument()
  );
}

// ── 1. Task list rendering ────────────────────────────────────────────────────

describe("Task list rendering", () => {
  it("shows the loading skeleton while fetching", async () => {
    // Never resolves during this test — keep the loading state visible.
    (getTasks as Mock).mockReturnValue(new Promise(() => {}));
    render(<TasksPage />);
    expect(await screen.findByRole("table", { name: "Tasks loading" })).toBeInTheDocument();
  });

  it("displays task title and description after data loads", async () => {
    await renderPage([buildTask()]);
    expect(screen.getByText("Standup reminder")).toBeInTheDocument();
    expect(screen.getByText("Ping the team channel")).toBeInTheDocument();
  });

  it("displays multiple tasks as separate rows", async () => {
    await renderPage([
      buildTask({ id: "t1", title: "Task Alpha" }),
      buildTask({ id: "t2", title: "Task Beta" }),
    ]);
    expect(screen.getByText("Task Alpha")).toBeInTheDocument();
    expect(screen.getByText("Task Beta")).toBeInTheDocument();
  });

  it("shows the 'No tasks yet' empty state with a New task button when task list is empty", async () => {
    await renderPage([]);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    // Both the page-header button and the empty-state button exist; at least one is present.
    expect(
      screen.getAllByRole("button", { name: /\+ new task/i }).length
    ).toBeGreaterThan(0);
  });

  it("shows an error banner when the fetch fails", async () => {
    (getTasks as Mock).mockRejectedValue(new Error("Network error"));
    render(<TasksPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
  });
});

// ── 2. Search and filtering ───────────────────────────────────────────────────

describe("Search and filtering", () => {
  beforeEach(() => {
    (getTasks as Mock).mockResolvedValue({
      tasks: [
        buildTask({ id: "t1", title: "Daily standup",    status: "active",   scheduleType: "cron" }),
        buildTask({ id: "t2", title: "Weekly digest",    status: "paused",   scheduleType: "cron" }),
        buildTask({ id: "t3", title: "Client follow-up", status: "active",   scheduleType: "interval",
          scheduleExpression: "every 6h" }),
      ],
      total: 3,
    });
  });

  it("searching by title hides non-matching tasks", async () => {
    render(<TasksPage />);
    await screen.findByText("Daily standup");

    const searchInput = screen.getByPlaceholderText(/search tasks/i);
    fireEvent.change(searchInput, { target: { value: "weekly" } });

    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.queryByText("Daily standup")).not.toBeInTheDocument();
    expect(screen.queryByText("Client follow-up")).not.toBeInTheDocument();
  });

  it("searching by description narrows results", async () => {
    (getTasks as Mock).mockResolvedValue({
      tasks: [
        buildTask({ id: "t1", title: "Task A", description: "Alpha description" }),
        buildTask({ id: "t2", title: "Task B", description: "Beta description" }),
      ],
      total: 2,
    });
    render(<TasksPage />);
    await screen.findByText("Task A");

    fireEvent.change(screen.getByPlaceholderText(/search tasks/i), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.queryByText("Task B")).not.toBeInTheDocument();
  });

  it("status filter 'paused' shows only paused tasks", async () => {
    render(<TasksPage />);
    await screen.findByText("Daily standup");

    const statusSelect = screen.getByRole("combobox", { name: /status/i });
    fireEvent.change(statusSelect, { target: { value: "paused" } });

    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.queryByText("Daily standup")).not.toBeInTheDocument();
    expect(screen.queryByText("Client follow-up")).not.toBeInTheDocument();
  });

  it("schedule type filter 'interval' shows only interval tasks", async () => {
    render(<TasksPage />);
    await screen.findByText("Daily standup");

    const schedSelect = screen.getByRole("combobox", { name: /schedule type/i });
    fireEvent.change(schedSelect, { target: { value: "interval" } });

    expect(screen.getByText("Client follow-up")).toBeInTheDocument();
    expect(screen.queryByText("Daily standup")).not.toBeInTheDocument();
    expect(screen.queryByText("Weekly digest")).not.toBeInTheDocument();
  });

  it("shows 'No matching tasks' when all tasks are filtered out", async () => {
    render(<TasksPage />);
    await screen.findByText("Daily standup");

    fireEvent.change(screen.getByPlaceholderText(/search tasks/i), {
      target: { value: "zzznosuchtask" },
    });

    expect(screen.getByText("No matching tasks")).toBeInTheDocument();
  });

  it("'Clear filters' button resets filters and shows all tasks again", async () => {
    render(<TasksPage />);
    await screen.findByText("Daily standup");

    fireEvent.change(screen.getByPlaceholderText(/search tasks/i), {
      target: { value: "zzznosuchtask" },
    });
    expect(screen.getByText("No matching tasks")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));

    expect(screen.getByText("Daily standup")).toBeInTheDocument();
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Client follow-up")).toBeInTheDocument();
  });
});

// ── 3. Create task flow ───────────────────────────────────────────────────────

describe("Create task flow", () => {
  const newTask = buildTask({
    id:    "task-new",
    title: "My new task",
    scheduleExpression: "every 2h",
    scheduleType: "interval",
    instructions: "Do the thing.",
  });

  beforeEach(() => {
    (getTasks as Mock).mockResolvedValue({ tasks: [], total: 0 });
    (createTask as Mock).mockResolvedValue(newTask);
  });

  it("clicking '+ New task' opens the create drawer", async () => {
    await renderPage([]);

    // Use the header button (first match) — the empty state also shows one.
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new task/i })[0]);

    expect(screen.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create task" })).toBeInTheDocument();
  });

  it("submitting a valid create form calls createTask with correct data", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new task/i })[0]);

    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: "My new task" } });
    fireEvent.change(screen.getByLabelText(/^expression/i), { target: { value: "every 2h" } });
    fireEvent.change(screen.getByLabelText(/^instructions/i), { target: { value: "Do the thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My new task", scheduleExpression: "every 2h" })
    );
  });

  it("shows a success banner after successful create", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new task/i })[0]);
    fireEvent.change(screen.getByLabelText(/^title/i),        { target: { value: "My new task" } });
    fireEvent.change(screen.getByLabelText(/^expression/i),   { target: { value: "every 2h" } });
    fireEvent.change(screen.getByLabelText(/^instructions/i), { target: { value: "Do the thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await screen.findByText("Task created.");
  });

  it("newly created task appears in the list", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new task/i })[0]);
    fireEvent.change(screen.getByLabelText(/^title/i),        { target: { value: "My new task" } });
    fireEvent.change(screen.getByLabelText(/^expression/i),   { target: { value: "every 2h" } });
    fireEvent.change(screen.getByLabelText(/^instructions/i), { target: { value: "Do the thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await screen.findByText("My new task");
  });

  it("closing the drawer via Cancel does not call createTask", async () => {
    await renderPage([]);
    fireEvent.click(screen.getAllByRole("button", { name: /\+ new task/i })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(createTask).not.toHaveBeenCalled();
  });
});

// ── 4. Edit task flow ─────────────────────────────────────────────────────────

describe("Edit task flow", () => {
  const original = buildTask({ id: "task-edit", title: "Original title" });
  const updated  = buildTask({ id: "task-edit", title: "Updated title" });

  beforeEach(() => {
    (getTasks  as Mock).mockResolvedValue({ tasks: [original], total: 1 });
    (updateTask as Mock).mockResolvedValue(updated);
  });

  it("clicking Edit opens the drawer in edit mode with task data pre-filled", async () => {
    await renderPage([original]);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("heading", { name: "Edit task" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Original title")).toBeInTheDocument();
  });

  it("clicking the task title button also opens the edit drawer", async () => {
    await renderPage([original]);

    // The title cell renders a <button> that opens the drawer
    fireEvent.click(screen.getByRole("button", { name: /original title/i }));

    expect(screen.getByRole("heading", { name: "Edit task" })).toBeInTheDocument();
  });

  it("saving changes calls updateTask with the task id and new values", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const titleInput = screen.getByDisplayValue("Original title");
    fireEvent.change(titleInput, { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1));
    expect(updateTask).toHaveBeenCalledWith(
      "task-edit",
      expect.objectContaining({ title: "Updated title" })
    );
  });

  it("shows a success banner after successful update", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Task updated.");
  });

  it("updated title is reflected in the task list", async () => {
    await renderPage([original]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Original title"), { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Updated title");
    expect(screen.queryByText("Original title")).not.toBeInTheDocument();
  });
});

// ── 5. Delete task flow ───────────────────────────────────────────────────────

describe("Delete task flow", () => {
  const task = buildTask({ id: "task-del", title: "Task to delete" });

  beforeEach(() => {
    (getTasks  as Mock).mockResolvedValue({ tasks: [task], total: 1 });
    (deleteTask as Mock).mockResolvedValue(undefined);
  });

  it("clicking Delete shows a confirmation dialog", async () => {
    await renderPage([task]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Delete task?")).toBeInTheDocument();
  });

  it("cancelling the dialog does not call deleteTask", async () => {
    await renderPage([task]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirming the dialog calls deleteTask with the task id", async () => {
    await renderPage([task]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(deleteTask).toHaveBeenCalledWith("task-del"));
  });

  it("task is removed from the list after successful deletion", async () => {
    await renderPage([task]);
    expect(screen.getByText("Task to delete")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() =>
      expect(screen.queryByText("Task to delete")).not.toBeInTheDocument()
    );
  });

  it("shows a success banner after deletion", async () => {
    await renderPage([task]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    await screen.findByText("Task deleted.");
  });
});

// ── 6. Enable / disable toggle ────────────────────────────────────────────────

describe("Enable/disable toggle", () => {
  it("toggling an enabled task calls toggleTask with enabled=false", async () => {
    const task = buildTask({ id: "t1", enabled: true, status: "active" });
    (getTasks  as Mock).mockResolvedValue({ tasks: [task], total: 1 });
    (toggleTask as Mock).mockResolvedValue({ ...task, enabled: false, status: "paused" });

    await renderPage([task]);

    // The toggle button's accessible name is its text content ("Enabled" when enabled).
    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith("t1", false)
    );
  });

  it("toggling a paused task calls toggleTask with enabled=true", async () => {
    const task = buildTask({ id: "t2", enabled: false, status: "paused" });
    (getTasks  as Mock).mockResolvedValue({ tasks: [task], total: 1 });
    (toggleTask as Mock).mockResolvedValue({ ...task, enabled: true, status: "active" });

    await renderPage([task]);

    // The toggle button's accessible name is its text content ("Paused" when paused).
    fireEvent.click(screen.getByRole("button", { name: "Paused" }));

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith("t2", true)
    );
  });

  it("enabled toggle button has aria-pressed=true; paused has aria-pressed=false", async () => {
    const task = buildTask({ enabled: true });
    (getTasks as Mock).mockResolvedValue({ tasks: [task], total: 1 });
    await renderPage([task]);

    expect(screen.getByRole("button", { name: "Enabled" })).toHaveAttribute("aria-pressed", "true");
  });
});
