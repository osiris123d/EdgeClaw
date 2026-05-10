import { useEffect, useId, useState } from "react";
import type { FeatureSettings } from "../../types";
import {
  CODEMODE_GUIDANCE_PLACEHOLDER,
  DEFAULT_CODEMODE_GUIDANCE_NOTES,
  MAX_CODEMODE_GUIDANCE_CHARS,
} from "../../constants/codemodeGuidanceDefaults";
import { buildCodemodeGuidanceText } from "../../lib/codemodeGuidanceServerMirror";

export interface CodemodeGuidanceCardProps {
  settings: FeatureSettings;
  /** Full settings merger (persists alongside other flags). */
  onChangeSettings: (next: FeatureSettings) => void;
  /** Persist a single key like `SettingsPage` `set(...)`. */
  setField: <K extends keyof FeatureSettings>(key: K, value: FeatureSettings[K]) => void;
  /**
   * When true, show collapsed dev preview of the exact bounded string workers derive from Settings
   * (Vite dev or Observability debug only — see SettingsPage wiring).
   */
  showEffectivePreview?: boolean;
}

function clampCodemodeGuidanceDraft(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.length > MAX_CODEMODE_GUIDANCE_CHARS
    ? normalized.slice(0, MAX_CODEMODE_GUIDANCE_CHARS)
    : normalized;
}

export function CodemodeGuidanceCard({
  settings,
  onChangeSettings,
  setField,
  showEffectivePreview = false,
}: CodemodeGuidanceCardProps) {
  const enableId = useId();
  const notesId = useId();
  const [draftNotes, setDraftNotes] = useState(settings.codemodeGuidanceNotes);

  const effectivePreview = showEffectivePreview
    ? buildCodemodeGuidanceText({
        codemodeGuidanceEnabled: settings.codemodeGuidanceEnabled,
        codemodeGuidanceNotes: draftNotes,
      })
    : undefined;

  useEffect(() => {
    setDraftNotes(settings.codemodeGuidanceNotes);
  }, [settings.codemodeGuidanceNotes]);

  const saveDraft = (): void => {
    const clipped = clampCodemodeGuidanceDraft(draftNotes);
    const trimmedTrailing = clipped.replace(/\s+$/u, "");
    setDraftNotes(clipped);
    setField("codemodeGuidanceNotes", trimmedTrailing);
  };

  const resetDefaults = (): void => {
    setDraftNotes(DEFAULT_CODEMODE_GUIDANCE_NOTES);
    onChangeSettings({
      ...settings,
      codemodeGuidanceEnabled: true,
      codemodeGuidanceNotes: DEFAULT_CODEMODE_GUIDANCE_NOTES,
    });
  };

  return (
    <section className="settings-card settings-codemode-guidance-card">
      <div className="settings-card-head">
        <div>
          <h3 className="settings-card-title">MCP / Codemode Guidance</h3>
          <p className="settings-card-desc muted">
            Add product-specific hints, canonical tool flows, and skill routing notes for MCP/Codemode
            tasks.
          </p>
        </div>
      </div>

      <label className="settings-codemode-guidance-label-row muted" htmlFor={enableId} style={{ fontSize: "0.88em" }}>
        <input
          id={enableId}
          type="checkbox"
          checked={settings.codemodeGuidanceEnabled}
          onChange={(e) => setField("codemodeGuidanceEnabled", e.target.checked)}
        />
        Enable guidance injection
      </label>

      <p className="muted settings-codemode-guidance-hint">
        Applied as additive tool/system context when guidance is enabled and notes are non-empty — max{" "}
        {MAX_CODEMODE_GUIDANCE_CHARS} characters.
      </p>

      <label className="settings-codemode-guidance-notes-label" htmlFor={notesId}>
        <span className="settings-codemode-guidance-notes-title">Guidance notes</span>
        <textarea
          id={notesId}
          className="settings-codemode-guidance-textarea"
          disabled={!settings.codemodeGuidanceEnabled}
          rows={6}
          spellCheck={true}
          value={draftNotes}
          placeholder={CODEMODE_GUIDANCE_PLACEHOLDER}
          aria-describedby={settings.codemodeGuidanceEnabled ? undefined : `${notesId}-off`}
          onChange={(e) => setDraftNotes(e.target.value.replace(/\r\n/g, "\n"))}
        />
      </label>
      {!settings.codemodeGuidanceEnabled && (
        <p id={`${notesId}-off`} className="muted settings-codemode-guidance-disabled-hint">
          Guidance is ignored while disabled (no injection into tool descriptions).
        </p>
      )}

      <div className="settings-codemode-guidance-actions">
        <button type="button" className="btn-primary" disabled={!settings.codemodeGuidanceEnabled} onClick={saveDraft}>
          Save
        </button>
        <button type="button" className="btn-header-secondary" onClick={resetDefaults}>
          Reset to defaults
        </button>
      </div>

      <details className="settings-codemode-guidance-examples muted">
        <summary className="settings-codemode-guidance-examples-summary">Examples</summary>
        <ul className="settings-codemode-guidance-examples-list">
          <li>
            Prefer the <code>cloudflare-dex-health</code> skill before WARP/DEX fleet checks.
          </li>
          <li>
            OpenAPI HTTP relays: <code>openapi_search</code> → <code>openapi_describe_operation</code> →{" "}
            <code>cloudflare_request</code>.
          </li>
          <li>Prefer <code>knownValues</code> sourced from structured tool payloads, not guesses.</li>
        </ul>
      </details>

      {showEffectivePreview && (
        <details className="settings-codemode-guidance-effective-preview muted">
          <summary className="settings-codemode-guidance-effective-preview-summary">
            Effective guidance preview{" "}
            <span className="settings-codemode-guidance-effective-preview-tag">dev / debug</span>
          </summary>
          <p className="settings-codemode-guidance-effective-preview-hint muted">
            Same processing as chat request settings: trim whitespace, CRLF normalization, omit when
            disabled or empty, capped at{" "}
            <code>{MAX_CODEMODE_GUIDANCE_CHARS}</code> chars. Reflects unsaved edits in the text area.
          </p>
          <pre className="settings-codemode-guidance-effective-preview-body" tabIndex={0}>
            {effectivePreview ?? "(none — disabled or blank after trim)"}
          </pre>
        </details>
      )}
    </section>
  );
}
