import { useEffect, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowDefinitionFormState,
  WorkflowTriggerMode,
  WorkflowApprovalMode,
} from "../../types/workflows";
import {
  TRIGGER_MODE_OPTIONS,
  APPROVAL_MODE_OPTIONS,
  WORKFLOW_TYPE_OPTIONS,
  DEFINITION_STATUS_OPTIONS,
} from "../../types/workflows";
import type {
  CreateWorkflowDefinitionInput,
  UpdateWorkflowDefinitionInput,
} from "../../lib/workflowsApi";
import { fetchWorkflowBindings } from "../../lib/workflowsApi";
import { DefTypeBadge }    from "./DefTypeBadge";
import { DefStatusBadge }  from "./DefStatusBadge";
import { TriggerModeTag }  from "./TriggerModeTag";
import { ApprovalModeTag } from "./ApprovalModeTag";

// ── Props ─────────────────────────────────────────────────────────────────────

interface WorkflowDefinitionDrawerProps {
  /**
   * undefined = drawer closed
   * null      = create mode
   * object    = edit mode
   */
  definition: WorkflowDefinition | null | undefined;
  saving:     boolean;
  onSave: (
    id:   string | null,
    data: CreateWorkflowDefinitionInput | UpdateWorkflowDefinitionInput,
  ) => void;
  onClose: () => void;
}

// ── Form constants ────────────────────────────────────────────────────────────

const BLANK: WorkflowDefinitionFormState = {
  name:               "",
  description:        "",
  workflowType:       "",
  triggerMode:        "manual",
  approvalMode:       "none",
  status:             "active",
  entrypoint:         "",
  instructions:       "",
  inputSchemaText:    "",
  examplePayloadText: "",
  enabled:            true,
  tagsText:           "",
};

function defToForm(def: WorkflowDefinition): WorkflowDefinitionFormState {
  return {
    name:               def.name,
    description:        def.description        ?? "",
    workflowType:       def.workflowType        ?? "",
    triggerMode:        def.triggerMode,
    approvalMode:       def.approvalMode,
    status:             def.status,
    entrypoint:         def.entrypoint,
    instructions:       def.instructions       ?? "",
    inputSchemaText:    def.inputSchemaText     ?? "",
    examplePayloadText: def.examplePayloadText  ?? "",
    enabled:            def.enabled,
    tagsText:           def.tags.join(", "),
  };
}

function parseTags(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

// ── Validation ────────────────────────────────────────────────────────────────

interface FormErrors {
  name?:               string;
  entrypoint?:         string;
  inputSchemaText?:    string;
  examplePayloadText?: string;
}

function validate(form: WorkflowDefinitionFormState): FormErrors {
  const errors: FormErrors = {};

  if (!form.name.trim()) {
    errors.name = "Name is required.";
  }
  if (!form.entrypoint.trim()) {
    errors.entrypoint = "Entrypoint is required.";
  } else if (!/^[A-Z][A-Z0-9_]*$/i.test(form.entrypoint.trim())) {
    errors.entrypoint = "Must be a valid binding name (letters, digits, underscores).";
  }
  if (form.inputSchemaText.trim()) {
    try { JSON.parse(form.inputSchemaText); }
    catch { errors.inputSchemaText = "Must be valid JSON."; }
  }
  if (form.examplePayloadText.trim()) {
    try { JSON.parse(form.examplePayloadText); }
    catch { errors.examplePayloadText = "Must be valid JSON."; }
  }

  return errors;
}

// ── Date / time helpers ───────────────────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

function fmtRelative(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const m  = Math.floor(ms / 60_000);
    if (m < 1)  return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 7 ? `${d}d ago` : fmtDate(iso);
  } catch { return "—"; }
}

// ── Sub-components ────────────────────────────────────────────────────────────

/** Live-updating summary card shown at the top of the form body. */
function DefinitionPreview({ form }: { form: WorkflowDefinitionFormState }) {
  const displayName = form.name.trim();
  return (
    <div className="wf-def-preview" aria-label="Definition preview">
      <div className="wf-def-preview-name-row">
        <span
          className={`wf-def-preview-dot${form.enabled ? " is-enabled" : ""}`}
          aria-hidden="true"
        />
        <span className="wf-def-preview-name">
          {displayName || (
            <span className="wf-def-preview-placeholder">Untitled workflow</span>
          )}
        </span>
      </div>
      <div className="wf-def-preview-chips">
        {form.workflowType && <DefTypeBadge type={form.workflowType} />}
        <TriggerModeTag mode={form.triggerMode} />
        <ApprovalModeTag mode={form.approvalMode} />
        <DefStatusBadge status={form.status} />
        <span className={`wf-def-preview-enabled-chip${form.enabled ? " is-on" : ""}`}>
          {form.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
    </div>
  );
}

/** Synthesised one-sentence description of how runs behave under current settings. */
function LaunchBehaviorNote({
  triggerMode,
  approvalMode,
}: {
  triggerMode:  WorkflowTriggerMode;
  approvalMode: WorkflowApprovalMode;
}) {
  const starts: Record<WorkflowTriggerMode, string> = {
    manual:    "Runs are started on demand",
    scheduled: "Runs start automatically on a schedule",
    event:     "Runs start when a trigger event is received",
  };
  const endings: Record<WorkflowApprovalMode, string> = {
    none:       "and begin executing immediately.",
    required:   "and wait for reviewer approval before executing.",
    checkpoint: "and pause at checkpoints for reviewer approval.",
  };

  return (
    <div className="wf-mode-hint">
      <svg
        width="13" height="13"
        viewBox="0 0 256 256"
        fill="currentColor"
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: 1 }}
      >
        <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a16,16,0,1,1,16,16A16,16,0,0,1,112,84Z" />
      </svg>
      <span>{starts[triggerMode]} {endings[approvalMode]}</span>
    </div>
  );
}

/** Small inline copy-to-clipboard button. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="wf-copy-btn"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/** Wrapper that renders a labelled form section with an all-caps title. */
function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="wf-drawer-section">
      <p className="wf-drawer-section-title">{title}</p>
      {children}
    </div>
  );
}

// ── Drawer component ──────────────────────────────────────────────────────────

export function WorkflowDefinitionDrawer({
  definition, saving, onSave, onClose,
}: WorkflowDefinitionDrawerProps) {
  const [form,     setForm]     = useState<WorkflowDefinitionFormState>(BLANK);
  const [,         setErrors]   = useState<FormErrors>({});
  const [touched,  setTouched]  = useState(false);
  const [bindings, setBindings] = useState<string[]>([]);

  // Load available workflow bindings once when the drawer opens.
  useEffect(() => {
    if (definition === undefined) return;
    const ac = new AbortController();
    fetchWorkflowBindings(ac.signal)
      .then(setBindings)
      .catch(() => { /* network error — dropdown stays empty, freetext fallback */ });
    return () => ac.abort();
  }, [definition]);

  useEffect(() => {
    if (definition === undefined) return;
    setForm(definition ? defToForm(definition) : BLANK);
    setErrors({});
    setTouched(false);
  }, [definition]);

  if (definition === undefined) return null;

  const isCreate = definition === null;
  const title    = isCreate ? "New workflow definition" : "Edit definition";

  function set<K extends keyof WorkflowDefinitionFormState>(
    key:   K,
    value: WorkflowDefinitionFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    const errs = validate(form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    const data: CreateWorkflowDefinitionInput = {
      name:               form.name.trim(),
      description:        form.description.trim()        || undefined,
      workflowType:       form.workflowType              || undefined,
      triggerMode:        form.triggerMode,
      approvalMode:       form.approvalMode,
      status:             form.status,
      entrypoint:         form.entrypoint.trim(),
      instructions:       form.instructions.trim()       || undefined,
      inputSchemaText:    form.inputSchemaText.trim()    || undefined,
      examplePayloadText: form.examplePayloadText.trim() || undefined,
      enabled:            form.enabled,
      tags:               parseTags(form.tagsText),
    };

    onSave(definition ? definition.id : null, data);
  }

  // Re-validate continuously once the user has attempted a submit.
  const errs = touched ? validate(form) : {};

  return (
    <aside className="tasks-drawer" aria-label={title}>

      {/* ── Sticky header ── */}
      <div className="tasks-drawer-header">
        <h3 className="tasks-drawer-title">{title}</h3>
        <button
          type="button"
          className="tasks-drawer-close"
          onClick={onClose}
          aria-label="Close drawer"
        >
          ✕
        </button>
      </div>

      {/* ── Scrollable body ── */}
      <form
        id="wfdef-form"
        className="tasks-drawer-body"
        onSubmit={handleSubmit}
        noValidate
      >

        {/* Live summary preview card */}
        <DefinitionPreview form={form} />

        {/* ════════════════════════════════
            Section 1 — Basics
            ════════════════════════════════ */}
        <FormSection title="Basics">

          {/* Name */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-name">
              Name
              <span aria-hidden="true" style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>
            </label>
            <input
              id="wfdef-name"
              type="text"
              className={`task-form-input${errs.name ? " is-error" : ""}`}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Daily Report Builder"
              maxLength={120}
              disabled={saving}
              autoFocus
            />
            {errs.name && <span className="task-form-error">{errs.name}</span>}
          </div>

          {/* Description */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-description">
              Description
            </label>
            <textarea
              id="wfdef-description"
              className="task-form-textarea"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What does this workflow do? Who should use it?"
              rows={2}
              disabled={saving}
            />
          </div>

          {/* Type */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-type">
              Workflow type
            </label>
            <select
              id="wfdef-type"
              className="memory-filter-select"
              style={{ width: "100%" }}
              value={form.workflowType}
              onChange={(e) => set("workflowType", e.target.value)}
              disabled={saving}
            >
              {WORKFLOW_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Enabled toggle */}
          <div className="wf-drawer-toggle-row">
            <button
              id="wfdef-enabled"
              type="button"
              role="switch"
              aria-checked={form.enabled}
              className={`task-toggle-btn${form.enabled ? " is-enabled" : ""}`}
              onClick={() => set("enabled", !form.enabled)}
              disabled={saving}
            >
              <span className="task-toggle-dot" aria-hidden="true" />
            </button>
            <label
              htmlFor="wfdef-enabled"
              className="wf-drawer-toggle-label"
              onClick={() => set("enabled", !form.enabled)}
            >
              {form.enabled ? "Enabled" : "Disabled"}
              <span className="wf-drawer-toggle-hint">
                {form.enabled
                  ? "Available for launch from the Definitions table"
                  : "Hidden from the launcher — runs cannot be started"}
              </span>
            </label>
          </div>

        </FormSection>

        {/* ════════════════════════════════
            Section 2 — Triggering
            ════════════════════════════════ */}
        <FormSection title="Triggering">

          {/* Trigger mode + Approval mode side-by-side */}
          <div className="wf-field-row">
            <div className="task-form-field" style={{ flex: 1 }}>
              <label className="task-form-label" htmlFor="wfdef-trigger">
                Trigger mode
              </label>
              <select
                id="wfdef-trigger"
                className="memory-filter-select"
                style={{ width: "100%" }}
                value={form.triggerMode}
                onChange={(e) => set("triggerMode", e.target.value as WorkflowDefinitionFormState["triggerMode"])}
                disabled={saving}
              >
                {TRIGGER_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="task-form-field" style={{ flex: 1 }}>
              <label className="task-form-label" htmlFor="wfdef-approval">
                Approval mode
              </label>
              <select
                id="wfdef-approval"
                className="memory-filter-select"
                style={{ width: "100%" }}
                value={form.approvalMode}
                onChange={(e) => set("approvalMode", e.target.value as WorkflowDefinitionFormState["approvalMode"])}
                disabled={saving}
              >
                {APPROVAL_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Synthesised behavior note */}
          <LaunchBehaviorNote
            triggerMode={form.triggerMode}
            approvalMode={form.approvalMode}
          />

          {/* Entrypoint (Cloudflare binding name) */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-entrypoint">
              Entrypoint
              <span aria-hidden="true" style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>
            </label>
            {bindings.length > 0 ? (
              <select
                id="wfdef-entrypoint"
                className={`task-form-input${errs.entrypoint ? " is-error" : ""}`}
                value={form.entrypoint}
                onChange={(e) => set("entrypoint", e.target.value)}
                disabled={saving}
              >
                <option value="">— select a workflow class —</option>
                {bindings.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            ) : (
              <input
                id="wfdef-entrypoint"
                type="text"
                className={`task-form-input wf-entrypoint-input${errs.entrypoint ? " is-error" : ""}`}
                value={form.entrypoint}
                onChange={(e) => set("entrypoint", e.target.value)}
                placeholder="EDGECLAW_RESEARCH_WORKFLOW"
                disabled={saving}
                spellCheck={false}
                autoComplete="off"
              />
            )}
            {errs.entrypoint ? (
              <span className="task-form-error">{errs.entrypoint}</span>
            ) : (
              <span className="task-form-hint">
                The <code>binding</code> name from <code>wrangler.jsonc</code>.{" "}
                {bindings.length === 0 && "Type it manually — the list could not be loaded."}
              </span>
            )}
          </div>

        </FormSection>

        {/* ════════════════════════════════
            Section 3 — Inputs
            ════════════════════════════════ */}
        <FormSection title="Inputs">

          {/* Input schema (JSON Schema) */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-schema">
              Input schema
              <span className="task-form-hint" style={{ marginLeft: 5, fontWeight: 400 }}>
                JSON Schema · optional
              </span>
            </label>
            <textarea
              id="wfdef-schema"
              className={`task-form-textarea wf-entrypoint-input${errs.inputSchemaText ? " is-error" : ""}`}
              value={form.inputSchemaText}
              onChange={(e) => set("inputSchemaText", e.target.value)}
              placeholder={'{\n  "type": "object",\n  "properties": {\n    "targetDate": { "type": "string" }\n  },\n  "required": ["targetDate"]\n}'}
              rows={6}
              disabled={saving}
              spellCheck={false}
            />
            {errs.inputSchemaText ? (
              <span className="task-form-error">{errs.inputSchemaText}</span>
            ) : (
              <span className="task-form-hint">
                Validates the JSON payload at launch time.
              </span>
            )}
          </div>

          {/* Example payload */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-example-payload">
              Example payload
              <span className="task-form-hint" style={{ marginLeft: 5, fontWeight: 400 }}>
                optional
              </span>
            </label>
            <textarea
              id="wfdef-example-payload"
              className={`task-form-textarea wf-entrypoint-input${errs.examplePayloadText ? " is-error" : ""}`}
              value={form.examplePayloadText}
              onChange={(e) => set("examplePayloadText", e.target.value)}
              placeholder={'{ "targetDate": "2026-04-22" }'}
              rows={3}
              disabled={saving}
              spellCheck={false}
            />
            {errs.examplePayloadText ? (
              <span className="task-form-error">{errs.examplePayloadText}</span>
            ) : (
              <span className="task-form-hint">
                Saved alongside the definition for testing and documentation.
              </span>
            )}
          </div>

        </FormSection>

        {/* ════════════════════════════════
            Section 4 — Behavior
            ════════════════════════════════ */}
        <FormSection title="Behavior">

          {/* Instructions / system prompt */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-instructions">
              Instructions
            </label>
            <textarea
              id="wfdef-instructions"
              className="task-form-textarea"
              value={form.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder="Optional prompt, context, or configuration forwarded to the workflow at launch."
              rows={4}
              disabled={saving}
            />
          </div>

          {/* Tags */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-tags">
              Tags
            </label>
            <input
              id="wfdef-tags"
              type="text"
              className="task-form-input"
              value={form.tagsText}
              onChange={(e) => set("tagsText", e.target.value)}
              placeholder="analytics, nightly, batch"
              disabled={saving}
            />
            <span className="task-form-hint">
              Comma-separated. Used for filtering and grouping in the Definitions table.
            </span>
          </div>

        </FormSection>

        {/* ════════════════════════════════
            Section 5 — Advanced
            ════════════════════════════════ */}
        <FormSection title="Advanced">

          {/* Definition lifecycle status */}
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wfdef-status">
              Definition status
            </label>
            <select
              id="wfdef-status"
              className="memory-filter-select"
              style={{ width: "100%" }}
              value={form.status}
              onChange={(e) => set("status", e.target.value as WorkflowDefinitionFormState["status"])}
              disabled={saving}
            >
              {DEFINITION_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="task-form-hint">
              Draft — not yet ready. Active — available for launch. Archived — retained but not launchable.
            </span>
          </div>

          {/* Read-only metadata */}
          <div className="wf-meta-grid">

            {/* ID row — full width */}
            <div className="wf-meta-item wf-meta-item-span">
              <span className="wf-meta-key">ID</span>
              {isCreate ? (
                <span className="wf-meta-val" style={{ color: "var(--muted)", fontStyle: "italic" }}>
                  Assigned on creation
                </span>
              ) : (
                <>
                  <span className="wf-meta-val wf-meta-val-mono">{definition.id}</span>
                  <CopyButton value={definition.id} />
                </>
              )}
            </div>

            {/* Created */}
            <div className="wf-meta-item">
              <span className="wf-meta-key">Created</span>
              <span className="wf-meta-val">
                {isCreate ? "—" : fmtDate(definition.createdAt)}
              </span>
            </div>

            {/* Updated */}
            <div className="wf-meta-item">
              <span className="wf-meta-key">Last updated</span>
              <span className="wf-meta-val">
                {isCreate ? "—" : fmtDate(definition.updatedAt)}
              </span>
            </div>

            {/* Last run + run count */}
            {!isCreate && (
              <>
                <div className="wf-meta-item">
                  <span className="wf-meta-key">Last run</span>
                  <span className="wf-meta-val">
                    {definition.lastRunAt ? fmtRelative(definition.lastRunAt) : "Never"}
                  </span>
                </div>
                <div className="wf-meta-item">
                  <span className="wf-meta-key">Total runs</span>
                  <span className="wf-meta-val">{definition.runCount}</span>
                </div>
              </>
            )}

          </div>

        </FormSection>

      </form>

      {/* ── Sticky footer ── */}
      <div className="tasks-drawer-footer">
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>

        {/* Validation summary — shown after first submit attempt */}
        {touched && Object.keys(errs).length > 0 && (
          <span className="wf-drawer-error-summary" role="alert">
            {Object.keys(errs).length === 1
              ? "Fix 1 error above"
              : `Fix ${Object.keys(errs).length} errors above`}
          </span>
        )}

        <button
          type="submit"
          form="wfdef-form"
          className="btn-primary"
          disabled={saving}
        >
          {saving
            ? "Saving…"
            : isCreate
              ? "Create definition"
              : "Save changes"}
        </button>
      </div>

    </aside>
  );
}
