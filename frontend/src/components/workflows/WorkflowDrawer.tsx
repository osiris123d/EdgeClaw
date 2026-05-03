import { useEffect, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowDefinitionFormState,
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

// ── Props ─────────────────────────────────────────────────────────────────────

interface WorkflowDrawerProps {
  /**
   * undefined = drawer closed
   * null      = create mode
   * object    = edit mode
   */
  definition: WorkflowDefinition | null | undefined;
  saving:     boolean;
  onSave:     (
    id: string | null,
    data: CreateWorkflowDefinitionInput | UpdateWorkflowDefinitionInput
  ) => void;
  onClose:    () => void;
}

// ── Form helpers ──────────────────────────────────────────────────────────────

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
  name?:           string;
  entrypoint?:     string;
  inputSchemaText?: string;
}

function validate(form: WorkflowDefinitionFormState): FormErrors {
  const errors: FormErrors = {};

  if (!form.name.trim()) {
    errors.name = "Name is required.";
  }

  if (!form.entrypoint.trim()) {
    errors.entrypoint = "Entrypoint is required.";
  } else if (!/^[A-Z][A-Z0-9_]*$/i.test(form.entrypoint.trim())) {
    errors.entrypoint =
      "Must be a valid binding name (letters, digits, underscores).";
  }

  if (form.inputSchemaText.trim()) {
    try {
      JSON.parse(form.inputSchemaText);
    } catch {
      errors.inputSchemaText = "Input schema must be valid JSON.";
    }
  }

  return errors;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WorkflowDrawer({
  definition, saving, onSave, onClose,
}: WorkflowDrawerProps) {
  const [form,    setForm]    = useState<WorkflowDefinitionFormState>(BLANK);
  const [, setErrors]  = useState<FormErrors>({});
  const [touched, setTouched] = useState(false);

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
    key: K, value: WorkflowDefinitionFormState[K],
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
      name:            form.name.trim(),
      description:     form.description.trim() || undefined,
      workflowType:    form.workflowType || undefined,
      triggerMode:     form.triggerMode,
      approvalMode:    form.approvalMode,
      status:          form.status,
      entrypoint:      form.entrypoint.trim(),
      instructions:    form.instructions.trim() || undefined,
      inputSchemaText: form.inputSchemaText.trim() || undefined,
      enabled:         form.enabled,
      tags:            parseTags(form.tagsText),
    };

    onSave(definition ? definition.id : null, data);
  }

  const errs = touched ? validate(form) : {};

  return (
    <aside className="tasks-drawer" aria-label={title}>

      {/* ── Header ── */}
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

      {/* ── Body ── */}
      <form
        className="tasks-drawer-body"
        id="wf-def-form"
        onSubmit={handleSubmit}
        noValidate
      >

        {/* Name */}
        <div className="task-form-field">
          <label className="task-form-label" htmlFor="wf-name">
            Name <span aria-hidden="true" style={{ color: "var(--danger)" }}>*</span>
          </label>
          <input
            id="wf-name"
            type="text"
            className={`task-form-input${errs.name ? " is-error" : ""}`}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Daily report"
            maxLength={120}
            disabled={saving}
          />
          {errs.name && (
            <span className="task-form-error">{errs.name}</span>
          )}
        </div>

        {/* Description */}
        <div className="task-form-field">
          <label className="task-form-label" htmlFor="wf-description">
            Description
          </label>
          <textarea
            id="wf-description"
            className="task-form-textarea"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What does this workflow do?"
            rows={2}
            disabled={saving}
          />
        </div>

        {/* Type + Trigger (side by side) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wf-type">
              Type
            </label>
            <select
              id="wf-type"
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
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wf-trigger">
              Trigger
            </label>
            <select
              id="wf-trigger"
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
        </div>

        {/* Approval + Status (side by side) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wf-approval">
              Approval
            </label>
            <select
              id="wf-approval"
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
          <div className="task-form-field">
            <label className="task-form-label" htmlFor="wf-status">
              Definition status
            </label>
            <select
              id="wf-status"
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
          </div>
        </div>

        {/* Entrypoint */}
        <div className="task-form-field">
          <label className="task-form-label" htmlFor="wf-entrypoint">
            Entrypoint <span aria-hidden="true" style={{ color: "var(--danger)" }}>*</span>
          </label>
          <input
            id="wf-entrypoint"
            type="text"
            className={`task-form-input wf-entrypoint-input${errs.entrypoint ? " is-error" : ""}`}
            value={form.entrypoint}
            onChange={(e) => set("entrypoint", e.target.value)}
            placeholder="MY_WORKFLOW"
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
          />
          {errs.entrypoint ? (
            <span className="task-form-error">{errs.entrypoint}</span>
          ) : (
            <span className="task-form-hint">
              Matches a <code>binding</code> name in the wrangler.jsonc workflows array.
            </span>
          )}
        </div>

        {/* Instructions */}
        <div className="task-form-field">
          <label className="task-form-label" htmlFor="wf-instructions">
            Instructions
          </label>
          <textarea
            id="wf-instructions"
            className="task-form-textarea"
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="Optional prompt or context forwarded to the workflow at launch."
            rows={3}
            disabled={saving}
          />
        </div>

        {/* Input schema */}
        <div className="task-form-field">
          <label className="task-form-label" htmlFor="wf-schema">
            Input schema <span className="task-form-hint" style={{ marginLeft: 4 }}>JSON Schema, optional</span>
          </label>
          <textarea
            id="wf-schema"
            className={`task-form-textarea wf-entrypoint-input${errs.inputSchemaText ? " is-error" : ""}`}
            value={form.inputSchemaText}
            onChange={(e) => set("inputSchemaText", e.target.value)}
            placeholder={'{\n  "type": "object",\n  "properties": { "targetDate": { "type": "string" } }\n}'}
            rows={4}
            disabled={saving}
            spellCheck={false}
          />
          {errs.inputSchemaText && (
            <span className="task-form-error">{errs.inputSchemaText}</span>
          )}
        </div>

        {/* Tags */}
        <div className="task-form-field">
          <label className="task-form-label" htmlFor="wf-tags">
            Tags
          </label>
          <input
            id="wf-tags"
            type="text"
            className="task-form-input"
            value={form.tagsText}
            onChange={(e) => set("tagsText", e.target.value)}
            placeholder="analytics, nightly, batch"
            disabled={saving}
          />
          <span className="task-form-hint">Comma-separated.</span>
        </div>

        {/* Enabled toggle */}
        <div className="wf-drawer-toggle-row">
          <button
            id="wf-enabled-toggle"
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
            htmlFor="wf-enabled-toggle"
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

      </form>

      {/* ── Footer ── */}
      <div className="tasks-drawer-footer">
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="submit"
          form="wf-def-form"
          className="btn-primary"
          disabled={saving}
        >
          {saving ? "Saving…" : isCreate ? "Create definition" : "Save changes"}
        </button>
      </div>

    </aside>
  );
}
