import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCoordinatorProject,
  getCoordinatorProject,
  patchCoordinatorProject,
  postCoordinatorBlueprintTemplates,
} from "../../lib/coordinatorControlPlaneApi";
import { computeBlueprintDocStates } from "../../lib/blueprintDocMeta";
import { slugifyProjectName } from "../../lib/projectSlug";
import type {
  BlueprintDocSourceState,
  BlueprintFileKey,
  CoordinatorProject,
  ProjectBlueprint,
} from "../../types/coordinatorControlPlane";
import { BLUEPRINT_FILE_KEYS } from "../../types/coordinatorControlPlane";

export interface ProjectBlueprintDialogProps {
  open: boolean;
  mode: "create" | "edit";
  /** Required when mode is \`edit\`. */
  projectId: string | null;
  storageAvailable: boolean;
  onClose: () => void;
  /** Called after a successful save; pass new \`projectId\` when mode was \`create\`. */
  onSaved: (createdProjectId?: string) => void;
  flash: (message: string, kind?: "success" | "error") => void;
}

function emptyDocs(): Partial<Record<BlueprintFileKey, string>> {
  const o: Partial<Record<BlueprintFileKey, string>> = {};
  for (const k of BLUEPRINT_FILE_KEYS) o[k] = "";
  return o;
}

function mergeDocsFromBlueprint(bp: ProjectBlueprint | undefined): Partial<Record<BlueprintFileKey, string>> {
  const o = emptyDocs();
  const d = bp?.docs ?? {};
  for (const k of BLUEPRINT_FILE_KEYS) {
    if (typeof d[k] === "string") o[k] = d[k];
  }
  return o;
}

function mergeFingerprintsFromBlueprint(
  bp: ProjectBlueprint | undefined
): Partial<Record<BlueprintFileKey, string>> {
  const o: Partial<Record<BlueprintFileKey, string>> = {};
  const fp = bp?.templateFingerprints ?? {};
  for (const k of BLUEPRINT_FILE_KEYS) {
    if (typeof fp[k] === "string") o[k] = fp[k];
  }
  return o;
}

function docStateClass(s: BlueprintDocSourceState | undefined): string {
  if (s === "validated") return "coord-doc-state coord-doc-state-validated";
  if (s === "template_only") return "coord-doc-state coord-doc-state-template";
  if (s === "edited") return "coord-doc-state coord-doc-state-edited";
  return "coord-doc-state coord-doc-state-missing";
}

function readinessClass(r: CoordinatorProject["readiness"]): string {
  if (r === "ready") return "coord-badge coord-badge-ok";
  if (r === "incomplete") return "coord-badge coord-badge-warn";
  return "coord-badge";
}

export function ProjectBlueprintDialog({
  open,
  mode,
  projectId,
  storageAvailable,
  onClose,
  onSaved,
  flash,
}: ProjectBlueprintDialogProps) {
  const slugTouched = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [pid, setPid] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [description, setDescription] = useState("");
  const [sharedProjectId, setSharedProjectId] = useState("");
  const [specPath, setSpecPath] = useState("PROJECT_SPEC.md");
  const [allowedScopeDirs, setAllowedScopeDirs] = useState("src/");
  const [activeFile, setActiveFile] = useState<BlueprintFileKey>("PROJECT_SPEC.md");
  const [docs, setDocs] = useState<Partial<Record<BlueprintFileKey, string>>>(() => emptyDocs());
  const [fingerprints, setFingerprints] = useState<Partial<Record<BlueprintFileKey, string>>>(() => ({}));
  /** Mirrors persisted blueprint schema (v2 required FILE_STRUCTURE for readiness after templates). */
  const [blueprintSchemaVersion, setBlueprintSchemaVersion] = useState<1 | 2>(1);
  const [lastSaved, setLastSaved] = useState<CoordinatorProject | null>(null);

  const resetCreate = useCallback(() => {
    slugTouched.current = false;
    const id = `proj-${crypto.randomUUID().slice(0, 8)}`;
    setPid(id);
    setProjectName("");
    setProjectSlug(slugifyProjectName(""));
    setDescription("");
    setSharedProjectId(id);
    setSpecPath("PROJECT_SPEC.md");
    setAllowedScopeDirs("src/");
    setActiveFile("PROJECT_SPEC.md");
    setDocs(emptyDocs());
    setFingerprints({});
    setBlueprintSchemaVersion(1);
    setLastSaved(null);
    setLoadErr(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (mode === "create") {
      resetCreate();
      return;
    }
    if (!projectId || !storageAvailable) return;
    let cancelled = false;
    setBusy(true);
    setLoadErr(null);
    void (async () => {
      try {
        const { project } = await getCoordinatorProject(projectId);
        if (cancelled) return;
        slugTouched.current = true;
        setPid(project.projectId);
        setProjectName(project.projectName);
        setProjectSlug(project.projectSlug);
        setDescription(project.description);
        setSharedProjectId(project.sharedProjectId);
        setSpecPath(project.specPath || "PROJECT_SPEC.md");
        setAllowedScopeDirs(project.allowedScopeDirs?.length ? project.allowedScopeDirs.join(", ") : "");
        setDocs(mergeDocsFromBlueprint(project.blueprint));
        setFingerprints(mergeFingerprintsFromBlueprint(project.blueprint));
        setBlueprintSchemaVersion(project.blueprint.schemaVersion === 2 ? 2 : 1);
        setLastSaved(project);
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, projectId, storageAvailable, resetCreate]);

  const onNameChange = useCallback(
    (v: string) => {
      setProjectName(v);
      if (!slugTouched.current) setProjectSlug(slugifyProjectName(v));
    },
    []
  );

  const onSlugChange = useCallback((v: string) => {
    slugTouched.current = true;
    setProjectSlug(v);
  }, []);

  const setDoc = useCallback((key: BlueprintFileKey, body: string) => {
    setDocs((d) => ({ ...d, [key]: body }));
  }, []);

  const liveDocStates = useMemo(
    () => computeBlueprintDocStates({ docs, templateFingerprints: fingerprints }),
    [docs, fingerprints]
  );

  const generateAllTemplates = useCallback(async () => {
    const name = projectName.trim() || "Untitled project";
    const slug = projectSlug.trim() || slugifyProjectName(name);
    setBusy(true);
    try {
      const { blueprint } = await postCoordinatorBlueprintTemplates({ projectName: name, projectSlug: slug });
      const next = emptyDocs();
      for (const k of BLUEPRINT_FILE_KEYS) {
        next[k] = blueprint.docs[k] ?? "";
      }
      setDocs(next);
      setFingerprints({ ...blueprint.templateFingerprints });
      setBlueprintSchemaVersion(blueprint.schemaVersion === 2 ? 2 : 1);
      setSharedProjectId((sid) => {
        const t = sid.trim();
        if (!t || t === pid.trim()) return slug;
        return sid;
      });
      flash("Templates generated — edit then save. Docs are marked template until you change them.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Template request failed", "error");
    } finally {
      setBusy(false);
    }
  }, [projectName, projectSlug, pid, flash]);

  const regenerateActiveTemplate = useCallback(async () => {
    const name = projectName.trim() || "Untitled project";
    const slug = projectSlug.trim() || slugifyProjectName(name);
    setBusy(true);
    try {
      const { blueprint } = await postCoordinatorBlueprintTemplates({
        projectName: name,
        projectSlug: slug,
        only: activeFile,
      });
      const body = blueprint.docs[activeFile];
      const fp = blueprint.templateFingerprints?.[activeFile];
      if (typeof body === "string") {
        setDocs((d) => ({ ...d, [activeFile]: body }));
      }
      if (typeof fp === "string") {
        setFingerprints((f) => ({ ...f, [activeFile]: fp }));
      }
      setBlueprintSchemaVersion(blueprint.schemaVersion === 2 ? 2 : 1);
      flash(`Regenerated ${activeFile}.`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Template request failed", "error");
    } finally {
      setBusy(false);
    }
  }, [projectName, projectSlug, activeFile, flash]);

  const onUpload = useCallback(
    (key: BlueprintFileKey, file: File | undefined) => {
      if (!file) return;
      void file.text().then((t) => {
        setDoc(key, t);
        setFingerprints((f) => {
          const next = { ...f };
          delete next[key];
          return next;
        });
      });
    },
    [setDoc]
  );

  const buildBlueprintPayload = useCallback((): ProjectBlueprint => {
    const out: ProjectBlueprint["docs"] = {};
    for (const k of BLUEPRINT_FILE_KEYS) {
      out[k] = docs[k] ?? "";
    }
    return { schemaVersion: blueprintSchemaVersion, docs: out, templateFingerprints: { ...fingerprints } };
  }, [docs, fingerprints, blueprintSchemaVersion]);

  const parseScopeDirs = useCallback((): string[] => {
    return allowedScopeDirs
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }, [allowedScopeDirs]);

  const handleSave = useCallback(async () => {
    if (!storageAvailable) return;
    const name = projectName.trim();
    if (!name) {
      flash("Project name is required.", "error");
      return;
    }
    const sid = sharedProjectId.trim();
    if (!sid) {
      flash("Shared project id is required.", "error");
      return;
    }
    setBusy(true);
    try {
      const blueprint = buildBlueprintPayload();
      const dirs = parseScopeDirs();
      if (mode === "create") {
        const row = await createCoordinatorProject({
          projectId: pid.trim(),
          projectName: name,
          projectSlug: projectSlug.trim() || slugifyProjectName(name),
          description: description.trim(),
          specPath: specPath.trim(),
          sharedProjectId: sid,
          status: "active",
          blueprint,
          allowedScopeDirs: dirs,
        });
        setLastSaved(row);
        flash(`Project saved — ${row.readiness}.`);
        onSaved(row.projectId);
      } else if (projectId) {
        const row = await patchCoordinatorProject(projectId, {
          projectName: name,
          projectSlug: projectSlug.trim() || slugifyProjectName(name),
          description: description.trim(),
          specPath: specPath.trim(),
          sharedProjectId: sid,
          blueprint,
          allowedScopeDirs: dirs,
        });
        setLastSaved(row);
        flash(`Blueprint updated — ${row.readiness}.`);
        onSaved();
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }, [
    storageAvailable,
    projectName,
    sharedProjectId,
    buildBlueprintPayload,
    parseScopeDirs,
    mode,
    pid,
    projectSlug,
    description,
    specPath,
    flash,
    onSaved,
    projectId,
  ]);

  if (!open) return null;

  return (
    <div className="coord-blueprint-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="coord-blueprint-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coord-blueprint-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="coord-blueprint-head">
          <h3 id="coord-blueprint-title">{mode === "create" ? "New project blueprint" : "Edit project blueprint"}</h3>
          <button type="button" className="btn-text" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {!storageAvailable ? (
          <p className="muted">Control-plane KV is not bound — open read-only.</p>
        ) : loadErr ? (
          <p className="coord-form-error">{loadErr}</p>
        ) : (
          <>
            <div className="coord-blueprint-meta">
              <label className="coord-field">
                <span>Project name</span>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="My service"
                  disabled={busy}
                />
              </label>
              <label className="coord-field">
                <span>Slug (URL segment)</span>
                <input
                  type="text"
                  value={projectSlug}
                  onChange={(e) => onSlugChange(e.target.value)}
                  placeholder="my-service"
                  disabled={busy}
                />
              </label>
              <label className="coord-field coord-field-wide">
                <span>Description</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short summary for operators"
                  disabled={busy}
                />
              </label>
              <label className="coord-field">
                <span>Project id</span>
                <input type="text" value={pid} readOnly className="coord-input-readonly" title="Stable registry id" />
              </label>
              <label className="coord-field">
                <span>Shared project id</span>
                <input
                  type="text"
                  value={sharedProjectId}
                  onChange={(e) => setSharedProjectId(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="coord-field">
                <span>Spec path (hint)</span>
                <input type="text" value={specPath} onChange={(e) => setSpecPath(e.target.value)} disabled={busy} />
              </label>
              <label className="coord-field coord-field-wide">
                <span>Allowed scope dirs (comma-separated)</span>
                <input type="text" value={allowedScopeDirs} onChange={(e) => setAllowedScopeDirs(e.target.value)} disabled={busy} />
              </label>
            </div>

            <div className="coord-blueprint-toolbar">
              <button
                type="button"
                className="btn-primary coord-small-btn"
                onClick={() => void generateAllTemplates()}
                disabled={busy}
              >
                Generate templates
              </button>
              <span className={`${docStateClass(liveDocStates[activeFile])} coord-doc-state-pill`} title="Per-file metadata">
                {activeFile.replace(/\.md$/, "")}: {liveDocStates[activeFile] ?? "missing"}
              </span>
              {lastSaved ? (
                <span className="coord-blueprint-status">
                  Project: <span className={readinessClass(lastSaved.readiness)}>{lastSaved.readiness}</span>
                </span>
              ) : null}
            </div>

            {lastSaved?.validationErrors?.length ? (
              <ul className="coord-validation-list">
                {lastSaved.validationErrors.map((err: string) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            ) : null}

            <div className="coord-blueprint-tabs" role="tablist" aria-label="Blueprint documents">
              {BLUEPRINT_FILE_KEYS.map((f: BlueprintFileKey) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={activeFile === f}
                  className={`coord-blueprint-tab${activeFile === f ? " is-active" : ""}`}
                  onClick={() => setActiveFile(f)}
                >
                  {f.replace(/\.md$/, "")}
                </button>
              ))}
            </div>

            <div className="coord-blueprint-editor-block">
              <div className="coord-blueprint-doc-actions">
                <button
                  type="button"
                  className="btn-header-secondary coord-small-btn"
                  onClick={() => void regenerateActiveTemplate()}
                  disabled={busy}
                >
                  Regenerate section
                </button>
                <label className="coord-inline-file">
                  <span className="btn-header-secondary coord-small-btn">Upload .md</span>
                  <input
                    type="file"
                    accept=".md,.markdown,.txt,text/markdown,text/plain"
                    className="coord-file-input-hidden"
                    disabled={busy}
                    onChange={(e) => {
                      onUpload(activeFile, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              <textarea
                className="coord-blueprint-textarea"
                value={docs[activeFile] ?? ""}
                onChange={(e) => setDoc(activeFile, e.target.value)}
                disabled={busy}
                spellCheck={false}
                rows={16}
              />
            </div>

            <div className="coord-blueprint-footer">
              <button type="button" className="btn-header-secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={busy || !storageAvailable}>
                {busy ? "Saving…" : "Save blueprint"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
