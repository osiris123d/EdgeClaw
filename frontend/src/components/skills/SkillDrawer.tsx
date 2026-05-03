import { useState, useEffect, useCallback, useRef } from "react";
import type { SkillDocument, CreateSkillInput, UpdateSkillInput } from "../../types/skills";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Discriminated union that drives what the right pane renders.
 *
 *   undefined          → empty state ("select a skill or create one")
 *   { mode:"loading" } → skeleton while a full document is being fetched
 *   { mode:"create" }  → blank create form
 *   { mode:"edit"  }   → edit form, key is read-only
 *   { mode:"preview" } → read-only view of content; "Edit" switches modes
 */
export type DrawerTarget =
  | undefined
  | { mode: "loading" }
  | { mode: "create" }
  | { mode: "edit";    doc: SkillDocument }
  | { mode: "preview"; doc: SkillDocument };

// ── Props ─────────────────────────────────────────────────────────────────────

interface SkillDrawerProps {
  target:            DrawerTarget;
  saving:            boolean;
  onSave:            (key: string | null, data: CreateSkillInput | UpdateSkillInput) => void;
  onClose:           () => void;
  onEditFromPreview: (doc: SkillDocument) => void;

  /**
   * Whether the currently previewed skill is loaded in the active chat session.
   * Drives the status badge in the preview header.  Safe to pass even when the
   * load/unload callbacks are absent — the badge is purely informational.
   */
  isLoaded?: boolean;

  /**
   * Called when the user explicitly asks to load this skill into the current
   * chat session's context window.
   *
   * ── NOT YET WIRED ────────────────────────────────────────────────────────
   * No safe server-side API currently exists to trigger load_context /
   * unload_context from outside the model's tool-call path.  Until one is
   * added, leave these props undefined.  When both are undefined the entire
   * "Session" action section is hidden so no broken affordance is shown.
   *
   * To enable these controls, implement two @callable() methods on MainAgent
   * (see the TODO comment near line 3290 of src/agents/MainAgent.ts), add
   * corresponding helpers in frontend/src/lib/skillsApi.ts, then pass the
   * callbacks via SkillsPage.
   * ─────────────────────────────────────────────────────────────────────────
   */
  onLoadIntoSession?:   (key: string) => void;
  /** Called when the user asks to unload this skill from the session context. */
  onUnloadFromSession?: (key: string) => void;
}

// ── Internal form state ───────────────────────────────────────────────────────

interface SkillFormState {
  key:         string;
  name:        string;
  description: string;
  content:     string;
  tags:        string[];
  tagInput:    string;
}

type FormField   = "key" | "name" | "description" | "content";
type FormErrors  = Partial<Record<FormField, string>>;
type FormTouched = Partial<Record<FormField, boolean>>;

const BLANK: SkillFormState = {
  key: "", name: "", description: "", content: "", tags: [], tagInput: "",
};

function docToForm(doc: SkillDocument): SkillFormState {
  return {
    key: doc.key, name: doc.name, description: doc.description,
    content: doc.content, tags: [...doc.tags], tagInput: "",
  };
}

// ── Slug helper ───────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
}

// ── Validation ────────────────────────────────────────────────────────────────

const KEY_RE = /^[a-z0-9][a-z0-9\-_]*$/;

function validate(form: SkillFormState, isEdit: boolean): FormErrors {
  const e: FormErrors = {};
  if (!isEdit) {
    if (!form.key.trim()) e.key = "Key is required.";
    else if (!KEY_RE.test(form.key.trim()))
      e.key = "Lowercase letters, digits, hyphens, or underscores. Must start with a letter or digit.";
  }
  if (!form.name.trim())        e.name        = "Name is required.";
  if (!form.description.trim()) e.description = "Description is required.";
  if (!form.content.trim())     e.content     = "Content is required.";
  return e;
}

// ── Date formatter ────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium", timeStyle: "short",
    });
  } catch { return iso; }
}

// ── Tag chip input ────────────────────────────────────────────────────────────

interface TagInputProps {
  tags:     string[];
  input:    string;
  disabled: boolean;
  onInput:  (v: string) => void;
  onAdd:    (tag: string) => void;
  onRemove: (tag: string) => void;
}

function TagInput({ tags, input, disabled, onInput, onAdd, onRemove }: TagInputProps) {
  const ref = useRef<HTMLInputElement>(null);

  function commit() {
    const t = input.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, "");
    if (t && !tags.includes(t)) onAdd(t);
    onInput("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    if (e.key === "Backspace" && !input && tags.length > 0) onRemove(tags[tags.length - 1]);
  }

  return (
    <div
      className="skills-tag-input-area"
      onClick={() => ref.current?.focus()}
    >
      {tags.map((tag) => (
        <span key={tag} className="skills-tag-chip">
          {tag}
          <button
            type="button"
            className="skills-tag-chip-remove"
            onClick={(e) => { e.stopPropagation(); onRemove(tag); }}
            disabled={disabled}
            aria-label={`Remove tag ${tag}`}
          >×</button>
        </span>
      ))}
      <input
        ref={ref}
        type="text"
        className="skills-tag-add-input"
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={tags.length === 0 ? "Add tags — Enter or comma to confirm…" : ""}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function PaneSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="skills-pane-section">
      <p className="skills-pane-section-label">{label}</p>
      {children}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function PaneEmpty({ onNew }: { onNew: () => void }) {
  return (
    <div className="skills-pane-empty">
      <svg
        className="skills-pane-empty-icon"
        width="44" height="44"
        viewBox="0 0 256 256"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H216V200H40Z" opacity="0.25"/>
        <rect x="64"  y="92"  width="128" height="11" rx="5.5"/>
        <rect x="64"  y="116" width="96"  height="11" rx="5.5"/>
        <rect x="64"  y="140" width="112" height="11" rx="5.5"/>
      </svg>
      <p className="skills-pane-empty-title">No skill selected</p>
      <p className="skills-pane-empty-desc">
        Choose a skill from the list to preview or edit its instructions.
      </p>
      <button type="button" className="skills-new-btn" style={{ fontSize: 12, padding: "5px 12px" }} onClick={onNew}>
        + New skill
      </button>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function PaneSkeleton() {
  return (
    <div className="skills-pane-loading">
      <div className="tasks-skeleton-line" style={{ width: "50%", height: 16 }} />
      <div className="tasks-skeleton-line" style={{ width: "80%", height: 12 }} />
      <div style={{ height: 6 }} />
      <div className="tasks-skeleton-line" style={{ width: "100%", height: 180, borderRadius: 8 }} />
      <div style={{ height: 4 }} />
      <div className="tasks-skeleton-line" style={{ width: "40%", height: 12 }} />
      <div className="tasks-skeleton-line" style={{ width: "60%", height: 12 }} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SkillDrawer({
  target,
  saving,
  onSave,
  onClose,
  onEditFromPreview,
  isLoaded,
  onLoadIntoSession,
  onUnloadFromSession,
}: SkillDrawerProps) {
  const isCreate  = target?.mode === "create";
  const isEdit    = target?.mode === "edit";
  const isPreview = target?.mode === "preview";
  const isForm    = isCreate || isEdit;

  // Sync key must include *mode* (e.g. preview:key vs edit:key). If it were only
  // doc.key, switching preview → edit would skip the effect — and when the focused
  // "Edit" button unmounts, focus can jump to the first tabbable (the header Save
  // submit button). A stray Enter then submits immediately with "Skill updated."
  const syncKey =
    target === undefined ? "__empty" :
    target.mode === "loading" ? "__loading" :
    target.mode === "create" ? "__new" :
    `${target.mode}:${target.doc.key}`;

  const [form,       setForm]       = useState<SkillFormState>(BLANK);
  const [errors,     setErrors]     = useState<FormErrors>({});
  const [touched,    setTouched]    = useState<FormTouched>({});
  const [keyTouched, setKeyTouched] = useState(false);

  // Reinitialise whenever target identity or pane mode changes (see syncKey).
  useEffect(() => {
    if (isCreate) {
      setForm(BLANK);
      setKeyTouched(false);
    } else if ((isEdit || isPreview) && target && "doc" in target) {
      setForm(docToForm(target.doc));
      setKeyTouched(true);
    }
    setErrors({});
    setTouched({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  // After entering edit mode, move focus into the form so it does not stay on the
  // header Save control (first tab stop when the old "Edit" control unmounts).
  useEffect(() => {
    if (!isEdit || !target || !("doc" in target)) return;
    const id = requestAnimationFrame(() => {
      document.getElementById("sp-name")?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isEdit, syncKey]);

  // Escape closes.
  useEffect(() => {
    if (!target) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && !saving) onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, saving, onClose]);

  const set = useCallback(<K extends keyof SkillFormState>(k: K, v: SkillFormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  }, []);

  function handleNameChange(name: string) {
    set("name", name);
    if (!keyTouched) set("key", slugify(name));
  }

  function touch(field: FormField) {
    setTouched((t) => ({ ...t, [field]: true }));
    setErrors(validate(form, isEdit));
  }

  function submitSkillForm() {
    setTouched({ key: true, name: true, description: true, content: true });
    const errs = validate(form, isEdit);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (isCreate) {
      onSave(null, {
        key: form.key.trim(), name: form.name.trim(),
        description: form.description.trim(), content: form.content.trim(),
        tags: form.tags,
      } satisfies CreateSkillInput);
    } else if (isEdit && target && "doc" in target) {
      onSave(target.doc.key, {
        name: form.name.trim(), description: form.description.trim(),
        content: form.content.trim(), tags: form.tags,
      } satisfies UpdateSkillInput);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitSkillForm();
  }

  const submitLabel = saving
    ? (isEdit ? "Saving…" : "Creating…")
    : (isEdit ? "Save changes" : "Create skill");

  // ── Empty / loading states don't use the pane chrome ─────────────────────

  if (target === undefined) {
    return (
      <div className="skills-pane-wrap">
        <PaneEmpty onNew={() => {}} /* parent controls this; onClose redirects to create */ />
      </div>
    );
  }

  if (target.mode === "loading") {
    return (
      <div className="skills-pane-wrap">
        <PaneSkeleton />
      </div>
    );
  }

  // ── Preview / Edit / Create ───────────────────────────────────────────────

  const doc = (isEdit || isPreview) && "doc" in target ? target.doc : null;

  return (
    <div className="skills-pane-wrap">

      {/* ── Pane header: title + action buttons ── */}
      <div className="skills-pane-header">
        <div className="skills-pane-title-group">
          <div className="skills-pane-title-row">
            <h3 className="skills-pane-title">
              {isPreview && doc ? doc.name : isEdit ? "Edit skill" : "New skill"}
            </h3>
            {isPreview && isLoaded && (
              <span className="skill-loaded-badge" aria-label="Currently in agent context">
                In session
              </span>
            )}
          </div>
          {isPreview && doc && (
            <p className="skills-pane-subtitle">{doc.description}</p>
          )}
          {isEdit && doc && (
            <p className="skills-pane-subtitle" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>
              {doc.key}
            </p>
          )}
        </div>

        <div className="skills-pane-actions">
          {isPreview && doc ? (
            <>
              <button
                type="button"
                className="btn-header-secondary"
                onClick={() => onEditFromPreview(doc)}
                disabled={saving}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn-header-secondary"
                onClick={onClose}
                disabled={saving}
                aria-label="Close"
              >
                ×
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn-primary"
                disabled={saving}
                style={{ padding: "6px 12px", fontSize: 12.5 }}
                onClick={() => submitSkillForm()}
              >
                {submitLabel}
              </button>
              <button
                type="button"
                className="btn-header-secondary"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Pane body ── */}
      <div className="skills-pane-body">

        {isPreview && doc ? (
          /* ── Preview ── */
          <>
            <PaneSection label="Content">
              <pre className="skills-preview-content" tabIndex={0}>{doc.content}</pre>
            </PaneSection>

            <PaneSection label="Metadata">
              <div className="skills-meta-row">
                <code style={{ fontSize: 11.5, color: "var(--muted)" }}>{doc.key}</code>
                <span className="skills-version-badge">v{doc.version}</span>
                {doc.tags.map((tag) => (
                  <span key={tag} className="skills-tag">{tag}</span>
                ))}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--muted)" }}>
                Updated {fmtDate(doc.updatedAt)}
              </p>
            </PaneSection>

            {/* ── Session controls ───────────────────────────────────────────
                Rendered only when the parent wires load/unload callbacks.
                When both are undefined this section is hidden entirely —
                no broken affordance is surfaced until a backend API exists.
                The model's own load_context / unload_context tool calls
                remain the default and primary loading mechanism.
                See the JSDoc on onLoadIntoSession for the wiring guide.
            ──────────────────────────────────────────────────────────────── */}
            {(onLoadIntoSession || onUnloadFromSession) && (
              <PaneSection label="Session">
                <div className="skills-session-actions">
                  {isLoaded ? (
                    <button
                      type="button"
                      className="skills-session-btn is-unload"
                      onClick={() => onUnloadFromSession?.(doc.key)}
                      disabled={saving}
                    >
                      Unload from chat
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="skills-session-btn is-load"
                      onClick={() => onLoadIntoSession?.(doc.key)}
                      disabled={saving}
                    >
                      Load into chat
                    </button>
                  )}
                  <p className="skills-session-hint">
                    {isLoaded
                      ? "Active in session context. The agent can reference this skill without calling load_context."
                      : "Manually load this skill's instructions into the active chat session."}
                  </p>
                </div>
              </PaneSection>
            )}
          </>
        ) : isForm ? (
          /* ── Create / Edit form ── */
          <form id="skill-pane-form" onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 0 }}>

            <PaneSection label="Identity">

              {/* Key */}
              <div className="task-form-field">
                <label htmlFor="sp-key" className="task-form-label">
                  Key{isCreate && <span className="task-form-required" aria-hidden="true"> *</span>}
                </label>
                <input
                  id="sp-key"
                  type="text"
                  className={`task-form-input task-form-mono${touched.key && errors.key ? " is-error" : ""}`}
                  value={form.key}
                  readOnly={isEdit}
                  onChange={(e) => { setKeyTouched(true); set("key", e.target.value); }}
                  onBlur={() => isCreate && touch("key")}
                  placeholder="e.g. code-reviewer"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                  style={isEdit ? { color: "var(--muted)", cursor: "default" } : undefined}
                />
                {isCreate && (
                  <span className="task-form-hint">
                    URL-safe key — lowercase letters, digits, hyphens, underscores.
                  </span>
                )}
                {touched.key && errors.key && (
                  <span className="task-form-error" role="alert">{errors.key}</span>
                )}
              </div>

              {/* Name */}
              <div className="task-form-field">
                <label htmlFor="sp-name" className="task-form-label">
                  Name <span className="task-form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="sp-name"
                  type="text"
                  className={`task-form-input${touched.name && errors.name ? " is-error" : ""}`}
                  value={form.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onBlur={() => touch("name")}
                  placeholder="Display name shown in the sidebar"
                  autoComplete="off"
                  autoFocus={isCreate}
                  disabled={saving}
                />
                {touched.name && errors.name && (
                  <span className="task-form-error" role="alert">{errors.name}</span>
                )}
              </div>

              {/* Description */}
              <div className="task-form-field">
                <label htmlFor="sp-desc" className="task-form-label">
                  Description <span className="task-form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="sp-desc"
                  type="text"
                  className={`task-form-input${touched.description && errors.description ? " is-error" : ""}`}
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  onBlur={() => touch("description")}
                  placeholder="One sentence — injected into system prompt for model discovery"
                  autoComplete="off"
                  disabled={saving}
                />
                {touched.description && errors.description && (
                  <span className="task-form-error" role="alert">{errors.description}</span>
                )}
              </div>

              {/* Tags */}
              <div className="task-form-field">
                <label className="task-form-label">Tags</label>
                <TagInput
                  tags={form.tags}
                  input={form.tagInput}
                  disabled={saving}
                  onInput={(v) => set("tagInput", v)}
                  onAdd={(tag) => set("tags", [...form.tags, tag])}
                  onRemove={(tag) => set("tags", form.tags.filter((t) => t !== tag))}
                />
                <span className="task-form-hint">
                  Press Enter or comma to add. Backspace removes the last tag.
                </span>
              </div>

            </PaneSection>

            <PaneSection label="Content">
              <div className="task-form-field" style={{ flex: 1 }}>
                <label htmlFor="sp-content" className="task-form-label">
                  Instructions <span className="task-form-required" aria-hidden="true">*</span>
                </label>
                <textarea
                  id="sp-content"
                  className={`task-form-textarea${touched.content && errors.content ? " is-error" : ""}`}
                  value={form.content}
                  onChange={(e) => set("content", e.target.value)}
                  onBlur={() => touch("content")}
                  placeholder="Full instruction text loaded by the model on demand via load_context…"
                  rows={12}
                  disabled={saving}
                  style={{ resize: "vertical", minHeight: 200 }}
                />
                {touched.content && errors.content && (
                  <span className="task-form-error" role="alert">{errors.content}</span>
                )}
                {form.content.length > 0 && (
                  <span className="task-form-hint">
                    {form.content.length.toLocaleString()} characters
                  </span>
                )}
              </div>
            </PaneSection>

            {/* Edit-mode metadata */}
            {isEdit && doc && (
              <PaneSection label="Metadata">
                <div className="skills-meta-row">
                  <span className="skills-version-badge">v{doc.version}</span>
                  <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    Updated {fmtDate(doc.updatedAt)}
                  </span>
                </div>
              </PaneSection>
            )}

          </form>
        ) : null}

      </div>
    </div>
  );
}
