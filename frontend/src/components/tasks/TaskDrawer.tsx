import { useState, useEffect } from "react";
import type {
  ScheduledTask,
  TaskType,
  ScheduleType,
  TaskFormState,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from "../../types/tasks";
import {
  TASK_TYPE_OPTIONS,
  SCHEDULE_TYPE_OPTIONS,
} from "../../types/tasks";

// ── Props ─────────────────────────────────────────────────────────────────────

interface TaskDrawerProps {
  /** undefined = closed; null = create mode; ScheduledTask = edit mode */
  task:    ScheduledTask | null | undefined;
  saving:  boolean;
  onSave:  (id: string | null, data: CreateScheduledTaskInput | UpdateScheduledTaskInput) => void;
  onClose: () => void;
}

// ── Internal form types ───────────────────────────────────────────────────────

// TaskFormState is defined in types/tasks.ts and imported above.

type FormField   = "title" | "scheduleExpression" | "instructions" | "payloadText";
type FormErrors  = Partial<Record<FormField, string>>;
type FormTouched = Partial<Record<FormField, boolean>>;

function initState(task: ScheduledTask | null | undefined): TaskFormState {
  if (!task) {
    return {
      title:              "",
      description:        "",
      taskType:           "reminder",
      scheduleType:       "interval",
      // Real default value — placeholders are not submitted; prefilled text avoids “Expression is required” when Interval is chosen.
      scheduleExpression: "every 1h",
      timezone:           "",
      enabled:            true,
      instructions:       "",
      payloadText:        "",
      payloadExpanded:    false,
    };
  }
  return {
    title:              task.title,
    description:        task.description ?? "",
    taskType:           task.taskType,
    scheduleType:       task.scheduleType,
    scheduleExpression: task.scheduleExpression,
    timezone:           task.timezone ?? "",
    enabled:            task.enabled,
    instructions:       task.instructions,
    payloadText:
      task.payload && Object.keys(task.payload).length > 0
        ? JSON.stringify(task.payload, null, 2)
        : "",
    payloadExpanded:
      !!task.payload && Object.keys(task.payload).length > 0,
  };
}

function validate(form: TaskFormState): FormErrors {
  const errs: FormErrors = {};
  if (!form.title.trim())               errs.title = "Title is required.";
  if (!form.scheduleExpression.trim())  errs.scheduleExpression = "Expression is required.";
  if (!form.instructions.trim())        errs.instructions = "Instructions are required.";
  if (form.payloadExpanded && form.payloadText.trim()) {
    try { JSON.parse(form.payloadText); }
    catch { errs.payloadText = "Must be valid JSON."; }
  }
  return errs;
}

// ── Cron description helper ───────────────────────────────────────────────────

/**
 * Maps common cron expressions to a human-friendly description.
 * Returns null for any expression that doesn't match a known pattern —
 * callers fall back to displaying the raw expression.
 */
function describeCron(expr: string): string | null {
  const e = expr.trim();

  function fmtHour(h: string): string {
    const n = parseInt(h, 10);
    if (n === 0)  return "midnight";
    if (n === 12) return "noon";
    if (n < 12)   return `${n} AM`;
    return `${n - 12} PM`;
  }

  const DAY_NAMES = [
    "Sundays", "Mondays", "Tuesdays", "Wednesdays",
    "Thursdays", "Fridays", "Saturdays",
  ];

  // Every minute
  if (e === "* * * * *") return "Every minute";

  // Every N minutes: */N * * * *
  const everyMin = /^\*\/(\d+) \* \* \* \*$/.exec(e);
  if (everyMin) return `Every ${everyMin[1]} minutes`;

  // Every hour: 0 * * * *
  if (e === "0 * * * *") return "Every hour";

  // Every N hours: 0 */N * * *
  const everyHr = /^0 \*\/(\d+) \* \* \*$/.exec(e);
  if (everyHr) return `Every ${everyHr[1]} hours`;

  // Weekdays at H: 0 H * * 1-5
  const weekdays = /^0 (\d{1,2}) \* \* 1-5$/.exec(e);
  if (weekdays) return `Weekdays at ${fmtHour(weekdays[1])}`;

  // Weekends at H: 0 H * * 0,6 or 6,0
  const weekends = /^0 (\d{1,2}) \* \* (0,6|6,0)$/.exec(e);
  if (weekends) return `Weekends at ${fmtHour(weekends[1])}`;

  // Daily at H: 0 H * * *
  const daily = /^0 (\d{1,2}) \* \* \*$/.exec(e);
  if (daily) return `Daily at ${fmtHour(daily[1])}`;

  // Specific weekday: 0 H * * D (0=Sun … 6=Sat)
  const weeklyDay = /^0 (\d{1,2}) \* \* ([0-6])$/.exec(e);
  if (weeklyDay) {
    return `${DAY_NAMES[parseInt(weeklyDay[2], 10)]} at ${fmtHour(weeklyDay[1])}`;
  }

  // Monthly on the Nth at H: 0 H D * *
  const monthly = /^0 (\d{1,2}) (\d{1,2}) \* \*$/.exec(e);
  if (monthly) {
    const h = fmtHour(monthly[1]);
    const d = parseInt(monthly[2], 10);
    const sfx = d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th";
    return `Monthly on the ${d}${sfx} at ${h}`;
  }

  return null;
}

// ── Schedule preview (human-readable) ────────────────────────────────────────

function schedulePreview(type: ScheduleType, expr: string, tz?: string): string {
  const e = expr.trim();
  if (!e) return "";
  const tzSuffix = tz ? ` (${tz})` : "";
  switch (type) {
    case "once": {
      try {
        const d = new Date(e);
        if (isNaN(d.getTime())) return `One-time: ${e}`;
        return `Runs once on ${d.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}${tzSuffix}`;
      } catch {
        return `One-time: ${e}`;
      }
    }
    case "interval":
      return `Runs ${e}${tzSuffix}`;
    case "cron": {
      const desc = describeCron(e);
      return desc ? `${desc} — ${e}${tzSuffix}` : `Cron — ${e}${tzSuffix}`;
    }
    default:
      return e;
  }
}

// ── Date formatter ────────────────────────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

// ── Section heading ───────────────────────────────────────────────────────────

function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="tasks-drawer-section">
      <h4 className="tasks-drawer-section-title">{title}</h4>
      {children}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaskDrawer({ task, saving, onSave, onClose }: TaskDrawerProps) {
  const isOpen = task !== undefined;
  const isEdit = task !== null && task !== undefined;

  // Derive a stable key: resets form only when identity changes (not data).
  const taskKey = task === undefined ? "__closed" : task === null ? "__new" : task.id;

  const [form,    setForm]    = useState<TaskFormState>(() => initState(task));
  const [errors,  setErrors]  = useState<FormErrors>({});
  const [touched, setTouched] = useState<FormTouched>({});

  // Re-init form whenever the "which task" identity changes.
  useEffect(() => {
    if (isOpen) {
      setForm(initState(task));
      setErrors({});
      setTouched({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKey]);

  const set = <K extends keyof TaskFormState>(key: K, value: TaskFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const touchField = (field: FormField) => {
    setTouched((t) => ({ ...t, [field]: true }));
    setErrors((prev) => ({ ...prev, ...validate(form) }));
  };

  const scheduleOption =
    SCHEDULE_TYPE_OPTIONS.find((o) => o.value === form.scheduleType) ??
    SCHEDULE_TYPE_OPTIONS[0];

  const preview = schedulePreview(
    form.scheduleType,
    form.scheduleExpression,
    form.timezone || undefined,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({
      title: true, scheduleExpression: true, instructions: true, payloadText: true,
    });
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    let payload: Record<string, unknown> | undefined;
    if (form.payloadExpanded && form.payloadText.trim()) {
      try { payload = JSON.parse(form.payloadText) as Record<string, unknown>; }
      catch { return; }
    }

    const data: CreateScheduledTaskInput = {
      title: form.title.trim(),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      taskType:           form.taskType,
      scheduleType:       form.scheduleType,
      scheduleExpression: form.scheduleExpression.trim(),
      ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
      enabled:     form.enabled,
      instructions: form.instructions.trim(),
      ...(payload ? { payload } : {}),
    };
    onSave(isEdit ? (task as ScheduledTask).id : null, data);
  }

  // Handle Escape key to close drawer.
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, saving, onClose]);

  return (
    <div
      className={`tasks-drawer-wrap${isOpen ? " is-open" : ""}`}
      aria-hidden={!isOpen}
    >
      <aside
        className="tasks-drawer"
        role="complementary"
        aria-label={isEdit ? "Edit task" : "New task"}
      >

        {/* ── Drawer header ── */}
        <div className="tasks-drawer-header">
          <h3 className="tasks-drawer-title">
            {isEdit ? "Edit task" : "New task"}
          </h3>
          <button
            type="button"
            className="tasks-drawer-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close editor"
          >
            ×
          </button>
        </div>

        {/* ── Scrollable form body ── */}
        <form
          id="task-drawer-form"
          className="tasks-drawer-body"
          onSubmit={handleSubmit}
          noValidate
        >

          {/* ═══ Basics ═══ */}
          <DrawerSection title="Basics">

            <div className="task-form-field">
              <label htmlFor="td-title" className="task-form-label">
                Title <span className="task-form-required" aria-hidden="true">*</span>
              </label>
              <input
                id="td-title"
                type="text"
                className={`task-form-input${touched.title && errors.title ? " is-error" : ""}`}
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                onBlur={() => touchField("title")}
                placeholder="Give this task a clear name"
                autoComplete="off"
                autoFocus={!isEdit}
                disabled={saving}
              />
              {touched.title && errors.title && (
                <span className="task-form-error" role="alert">{errors.title}</span>
              )}
            </div>

            <div className="task-form-field">
              <label htmlFor="td-desc" className="task-form-label">Description</label>
              <input
                id="td-desc"
                type="text"
                className="task-form-input"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Short optional summary (shown in task list)"
                autoComplete="off"
                disabled={saving}
              />
            </div>

            <div className="task-form-field">
              <label htmlFor="td-tasktype" className="task-form-label">Task type</label>
              <select
                id="td-tasktype"
                className="task-form-select"
                value={form.taskType}
                onChange={(e) => set("taskType", e.target.value as TaskType)}
                disabled={saving}
              >
                {TASK_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="task-form-toggle-row">
              <label className="task-form-toggle-label">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => set("enabled", e.target.checked)}
                  disabled={saving}
                />
                <span>Enabled</span>
              </label>
              <span className="task-form-hint">
                {form.enabled
                  ? "Task will run on its schedule."
                  : "Task is paused and will not run."}
              </span>
            </div>

          </DrawerSection>

          {/* ═══ Schedule ═══ */}
          <DrawerSection title="Schedule">

            <div className="task-form-field">
              <label htmlFor="td-schedtype" className="task-form-label">Schedule type</label>
              <select
                id="td-schedtype"
                className="task-form-select"
                value={form.scheduleType}
                onChange={(e) => {
                  const next = e.target.value as ScheduleType;
                  set("scheduleType", next);
                  set("scheduleExpression", next === "interval" ? "every 1h" : "");
                }}
                disabled={saving}
              >
                {SCHEDULE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="task-form-field">
              <label htmlFor="td-expr" className="task-form-label">
                Expression <span className="task-form-required" aria-hidden="true">*</span>
              </label>
              <input
                id="td-expr"
                type="text"
                className={`task-form-input task-form-mono${
                  touched.scheduleExpression && errors.scheduleExpression ? " is-error" : ""
                }`}
                value={form.scheduleExpression}
                onChange={(e) => set("scheduleExpression", e.target.value)}
                onBlur={() => touchField("scheduleExpression")}
                placeholder={scheduleOption.placeholder}
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
              />
              <span className="task-form-hint">{scheduleOption.hint}</span>
              {touched.scheduleExpression && errors.scheduleExpression && (
                <span className="task-form-error" role="alert">
                  {errors.scheduleExpression}
                </span>
              )}
            </div>

            <div className="task-form-field">
              <label htmlFor="td-tz" className="task-form-label">Timezone</label>
              <input
                id="td-tz"
                type="text"
                className="task-form-input"
                value={form.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                placeholder="America/Chicago — optional, defaults to UTC"
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
              />
            </div>

            {preview && (
              <div className="tasks-drawer-preview" role="status" aria-live="polite">
                <svg
                  width="12" height="12"
                  viewBox="0 0 256 256"
                  fill="currentColor"
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 1 }}
                >
                  <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z" />
                </svg>
                {preview}
              </div>
            )}

          </DrawerSection>

          {/* ═══ Behavior ═══ */}
          <DrawerSection title="Behavior">

            <div className="task-form-field">
              <label htmlFor="td-instructions" className="task-form-label">
                Instructions <span className="task-form-required" aria-hidden="true">*</span>
              </label>
              <textarea
                id="td-instructions"
                className={`task-form-textarea${
                  touched.instructions && errors.instructions ? " is-error" : ""
                }`}
                value={form.instructions}
                onChange={(e) => set("instructions", e.target.value)}
                onBlur={() => touchField("instructions")}
                placeholder="Tell the agent exactly what to do when this task runs…"
                rows={5}
                disabled={saving}
              />
              {touched.instructions && errors.instructions && (
                <span className="task-form-error" role="alert">{errors.instructions}</span>
              )}
            </div>

            <div className="task-form-field">
              <button
                type="button"
                className="task-form-collapsible"
                aria-expanded={form.payloadExpanded}
                onClick={() => set("payloadExpanded", !form.payloadExpanded)}
              >
                <span>Payload JSON</span>
                <span
                  className={`turn-caret${form.payloadExpanded ? " is-open" : ""}`}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </button>
              {form.payloadExpanded && (
                <>
                  <textarea
                    className={`task-form-textarea task-form-mono${
                      touched.payloadText && errors.payloadText ? " is-error" : ""
                    }`}
                    value={form.payloadText}
                    onChange={(e) => set("payloadText", e.target.value)}
                    onBlur={() => touchField("payloadText")}
                    placeholder={'{\n  "key": "value"\n}'}
                    rows={4}
                    spellCheck={false}
                    disabled={saving}
                    aria-label="Payload JSON"
                  />
                  <span className="task-form-hint">
                    Optional structured data forwarded to the agent at run time.
                  </span>
                  {touched.payloadText && errors.payloadText && (
                    <span className="task-form-error" role="alert">{errors.payloadText}</span>
                  )}
                </>
              )}
            </div>

          </DrawerSection>

          {/* ═══ Advanced (edit mode only) ═══ */}
          {isEdit && task && (
            <DrawerSection title="Advanced">
              <dl className="tasks-drawer-meta-list">
                {(
                  [
                    ["Task ID",  <code key="id" className="task-meta-code">{task.id}</code>],
                    ["Created",  fmtDate(task.createdAt)],
                    ["Updated",  fmtDate(task.updatedAt)],
                    ["Last run", fmtDate(task.lastRunAt) || "—"],
                    ["Next run",
                      task.nextRunAt
                        ? fmtDate(task.nextRunAt)
                        : task.enabled && task.scheduleType === "cron"
                          ? <span key="rt" className="task-meta-at-runtime">Calculated at runtime</span>
                          : "—",
                    ],
                  ] as [string, React.ReactNode][]
                ).map(([label, value]) => (
                  <div key={label} className="tasks-drawer-meta-row">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}

                {/* ── Run result (shown once a task has been executed) ── */}
                {task.lastRunStatus != null && (
                  <div className="tasks-drawer-meta-row">
                    <dt>Last run result</dt>
                    <dd>
                      <span className={`task-run-result is-${task.lastRunStatus}`}>
                        {task.lastRunStatus === "success" ? "✓ Success" : "✗ Failed"}
                      </span>
                    </dd>
                  </div>
                )}
                {task.lastRunStatus === "failed" && task.lastRunError && (
                  <div className="tasks-drawer-meta-row tasks-drawer-meta-row-error">
                    <dt>Error detail</dt>
                    <dd className="task-run-error-msg">{task.lastRunError}</dd>
                  </div>
                )}
              </dl>
            </DrawerSection>
          )}

        </form>

        {/* ── Sticky footer: save + cancel ── */}
        <div className="tasks-drawer-footer">
          <button
            type="submit"
            form="task-drawer-form"
            className="btn-primary"
            disabled={saving}
          >
            {saving
              ? (isEdit ? "Saving…"   : "Creating…")
              : (isEdit ? "Save changes" : "Create task")}
          </button>
          <button
            type="button"
            className="btn-header-secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
        </div>

      </aside>
    </div>
  );
}
