/**
 * WorkflowLaunchDrawer
 *
 * Lightweight launch drawer that lets the user optionally supply a JSON input
 * payload before confirming a workflow run.  Lighter than the definition editor
 * — focused on the launch moment only.
 *
 * Props:
 *   definition  — undefined = drawer closed; object = launch target
 *   launching   — true while the parent is waiting for the API call to resolve
 *   launchResult — populated by the parent after a successful launch
 *   onLaunch    — called with (definitionId, payload?) when user confirms
 *   onViewRun   — called when user clicks "View run" in the success state
 *   onClose     — called when user dismisses (Cancel / ✕ / backdrop click)
 */

import { useState, useEffect } from "react";
import type { WorkflowDefinition, WorkflowRun } from "../../types/workflows";

// ── Props ─────────────────────────────────────────────────────────────────────

interface WorkflowLaunchDrawerProps {
  definition:   WorkflowDefinition | undefined;
  launching:    boolean;
  launchResult: WorkflowRun | undefined;
  onLaunch:     (definitionId: string, payload?: Record<string, unknown>) => void;
  onViewRun:    (run: WorkflowRun) => void;
  onClose:      () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ModeChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="wf-launch-chip">
      <span className="wf-launch-chip-label">{label}</span>
      <span className="wf-launch-chip-value">{value}</span>
    </span>
  );
}

function triggerLabel(mode: WorkflowDefinition["triggerMode"]): string {
  return mode === "manual" ? "Manual" : mode === "scheduled" ? "Scheduled" : "Event";
}

function approvalLabel(mode: WorkflowDefinition["approvalMode"]): string {
  return mode === "none" ? "No approval" : mode === "required" ? "Approval required" : "Checkpoint";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WorkflowLaunchDrawer({
  definition,
  launching,
  launchResult,
  onLaunch,
  onViewRun,
  onClose,
}: WorkflowLaunchDrawerProps) {
  const [payloadText,   setPayloadText]   = useState("");
  const [payloadError,  setPayloadError]  = useState<string | null>(null);
  const [schemaOpen,    setSchemaOpen]    = useState(false);

  // Reset form when a new definition is opened.
  useEffect(() => {
    if (definition) {
      setPayloadText("");
      setPayloadError(null);
      setSchemaOpen(false);
    }
  }, [definition?.id]);

  if (!definition) return null;

  // After the guard, use a local const so TypeScript's narrowing holds inside closures.
  const def = definition;

  // ── JSON validation ─────────────────────────────────────────────────────────

  function parsePayload(): Record<string, unknown> | null | "empty" {
    const trimmed = payloadText.trim();
    if (!trimmed) return "empty";
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setPayloadError("Payload must be a JSON object { … }.");
        return null;
      }
      setPayloadError(null);
      return parsed as Record<string, unknown>;
    } catch {
      setPayloadError("Invalid JSON — check brackets, commas, and quotes.");
      return null;
    }
  }

  function handleLaunch() {
    const result = parsePayload();
    if (result === null) return; // validation failed
    onLaunch(def.id, result === "empty" ? undefined : result);
  }

  function handleUseExample() {
    if (def.examplePayloadText) {
      setPayloadText(def.examplePayloadText);
      setPayloadError(null);
    }
  }

  // ── Success state ───────────────────────────────────────────────────────────

  if (launchResult) {
    return (
      <aside className="tasks-drawer wf-launch-drawer" aria-label="Workflow launched">
        <div className="tasks-drawer-header">
          <h3 className="tasks-drawer-title">Launched</h3>
          <button
            type="button"
            className="tasks-drawer-close"
            onClick={onClose}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>

        <div className="tasks-drawer-body wf-launch-success">
          <div className="wf-launch-success-icon" aria-hidden="true">✓</div>
          <p className="wf-launch-success-title">Run started</p>
          <p className="wf-launch-success-subtitle">
            <strong>{def.name}</strong> is now running.
          </p>
          <code className="wf-launch-run-id">
            {launchResult.id}
          </code>
        </div>

        <div className="tasks-drawer-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => { onViewRun(launchResult); onClose(); }}
          >
            View run
          </button>
        </div>
      </aside>
    );
  }

  // ── Normal (launch-ready) state ─────────────────────────────────────────────

  const hasSchema  = !!def.inputSchemaText?.trim();
  const hasExample = !!def.examplePayloadText?.trim();

  return (
    <aside className="tasks-drawer wf-launch-drawer" aria-label={`Launch ${def.name}`}>

      {/* Header */}
      <div className="tasks-drawer-header">
        <h3 className="tasks-drawer-title wf-launch-title">
          <span className="wf-launch-title-label">Launch</span>
          <span className="wf-launch-title-name">{def.name}</span>
        </h3>
        <button
          type="button"
          className="tasks-drawer-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="tasks-drawer-body">

        {/* Mode chips */}
        <div className="wf-launch-chips">
          {def.workflowType && (
            <ModeChip label="Type" value={def.workflowType} />
          )}
          <ModeChip label="Trigger"  value={triggerLabel(def.triggerMode)} />
          <ModeChip label="Approval" value={approvalLabel(def.approvalMode)} />
        </div>

        {def.description && (
          <p className="wf-launch-description">{def.description}</p>
        )}

        {/* Input schema (collapsible) */}
        {hasSchema && (
          <div className="wf-launch-schema-section">
            <button
              type="button"
              className="wf-launch-schema-toggle"
              onClick={() => setSchemaOpen((o) => !o)}
              aria-expanded={schemaOpen}
            >
              <span className="wf-launch-schema-toggle-arrow" aria-hidden="true">
                {schemaOpen ? "▾" : "▸"}
              </span>
              Input schema
            </button>
            {schemaOpen && (
              <pre className="wf-launch-schema-body">
                {def.inputSchemaText}
              </pre>
            )}
          </div>
        )}

        {/* Payload textarea */}
        <div className="tasks-field-group">
          <div className="wf-launch-payload-header">
            <label className="tasks-field-label" htmlFor="wf-launch-payload">
              Input payload
              <span className="tasks-field-optional"> (optional)</span>
            </label>
            {hasExample && (
              <button
                type="button"
                className="wf-launch-example-btn"
                onClick={handleUseExample}
                disabled={launching}
              >
                Use example
              </button>
            )}
          </div>
          <textarea
            id="wf-launch-payload"
            className={`tasks-textarea wf-launch-payload-textarea${payloadError ? " is-invalid" : ""}`}
            placeholder={'{\n  "key": "value"\n}'}
            value={payloadText}
            onChange={(e) => {
              setPayloadText(e.target.value);
              if (payloadError) setPayloadError(null);
            }}
            disabled={launching}
            rows={6}
            spellCheck={false}
          />
          {payloadError && (
            <p className="tasks-field-error" role="alert">{payloadError}</p>
          )}
        </div>

      </div>

      {/* Footer */}
      <div className="tasks-drawer-footer">
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={launching}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary btn-launch"
          onClick={handleLaunch}
          disabled={launching}
        >
          {launching ? "Launching…" : "Launch"}
        </button>
      </div>

    </aside>
  );
}
