import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { SkillSummary, CreateSkillInput, UpdateSkillInput } from "../types/skills";
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
} from "../lib/skillsApi";
import { SkillRow }    from "../components/skills/SkillRow";
import { SkillDrawer } from "../components/skills/SkillDrawer";
import type { DrawerTarget } from "../components/skills/SkillDrawer";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Banner {
  kind:    "success" | "error";
  message: string;
}

type SortKey = "updatedAt" | "name";

// ── Sort ──────────────────────────────────────────────────────────────────────

function sortSkills(skills: SkillSummary[], sort: SortKey): SkillSummary[] {
  return [...skills].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : b.updatedAt.localeCompare(a.updatedAt)
  );
}

// ── SkillsPage ─────────────────────────────────────────────────────────────────

interface SkillsPageProps {
  /**
   * Set of skill keys currently loaded in the agent's context window.
   * Derive via `deriveLoadedSkillKeys` from `lib/loadedSkillKeys.ts` once
   * the chat timeline context events are lifted to App-level state.
   */
  loadedKeys?: ReadonlySet<string>;

  // ── Session load / unload controls ────────────────────────────────────────
  //
  // TODO: Wire these callbacks once a backend session API exists.
  //
  // When provided, the SkillDrawer preview pane surfaces "Load into chat" /
  // "Unload from chat" buttons.  When undefined (current default), those
  // buttons are hidden entirely — no broken affordance is shown.
  //
  // To enable them:
  //   1. Add @callable() loadSkillIntoSession(key) and
  //      unloadSkillFromSession(key) to MainAgent (see TODO comment there).
  //   2. Add loadSkillIntoSession / unloadSkillFromSession to skillsApi.ts.
  //   3. Pass real handlers here from App.tsx.
  //   4. Call the optimistic loadedKeys updater so the badge reflects the
  //      change immediately without waiting for the next chat timeline event.

  /** Called when the user clicks "Load into chat" in the skill preview pane. */
  onLoadIntoSession?:   (key: string) => void;
  /** Called when the user clicks "Unload from chat" in the skill preview pane. */
  onUnloadFromSession?: (key: string) => void;
}

export function SkillsPage({
  loadedKeys = new Set(),
  onLoadIntoSession,
  onUnloadFromSession,
}: SkillsPageProps) {
  // ── Data ───────────────────────────────────────────────────────────────────
  const [skills,  setSkills]  = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [banner,  setBanner]  = useState<Banner | null>(null);

  // ── Sidebar controls ───────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [sort,   setSort]   = useState<SortKey>("updatedAt");

  // ── Right-pane state ───────────────────────────────────────────────────────
  const [pane, setPane] = useState<DrawerTarget>(undefined);

  // ── Confirm delete ─────────────────────────────────────────────────────────
  const [deleteKey, setDeleteKey] = useState<string | null>(null);

  const abortRef    = useRef<AbortController | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Banner ─────────────────────────────────────────────────────────────────

  const flash = useCallback((message: string, kind: Banner["kind"] = "success") => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ kind, message });
    bannerTimer.current = setTimeout(() => setBanner(null), 3_500);
  }, []);

  // ── Load list ──────────────────────────────────────────────────────────────

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await listSkills(signal);
      if (!signal?.aborted) setSkills(result.skills);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      flash(err instanceof Error ? err.message : "Failed to load skills.", "error");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    const ctl = new AbortController();
    abortRef.current = ctl;
    void load(ctl.signal);
    return () => {
      ctl.abort();
      if (bannerTimer.current) clearTimeout(bannerTimer.current);
    };
  }, [load]);

  // ── Open pane with full doc ─────────────────────────────────────────────────

  async function openPaneFor(key: string, intent: "edit" | "preview") {
    setPane({ mode: "loading" });
    try {
      const doc = await getSkill(key);
      if (!doc) {
        setPane(undefined);
        flash(`Skill "${key}" not found.`, "error");
        return;
      }
      setPane({ mode: intent, doc });
    } catch (err) {
      setPane(undefined);
      flash(err instanceof Error ? err.message : "Failed to load skill.", "error");
    }
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async function handleSave(key: string | null, data: CreateSkillInput | UpdateSkillInput) {
    setSaving(true);
    try {
      if (key) {
        const updated = await updateSkill(key, data as UpdateSkillInput);
        setSkills((prev) => prev.map((s) => (s.key === key ? { ...s, ...updated } : s)));
        flash("Skill updated.");
      } else {
        const created = await createSkill(data as CreateSkillInput);
        setSkills((prev) => [created, ...prev]);
        flash("Skill created.");
      }
      setPane(undefined);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to save skill.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(key: string) {
    setDeleteKey(null);
    setSaving(true);
    try {
      await deleteSkill(key);
      setSkills((prev) => prev.filter((s) => s.key !== key));
      setPane((prev) => {
        if (!prev || prev.mode === "loading" || prev.mode === "create") return prev;
        if ("doc" in prev && prev.doc.key === key) return undefined;
        return prev;
      });
      flash("Skill deleted.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to delete skill.", "error");
    } finally {
      setSaving(false);
    }
  }

  // ── Derived list ───────────────────────────────────────────────────────────

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.tags.some((t) => t.toLowerCase().includes(q))
        )
      : skills;
    return sortSkills(filtered, sort);
  }, [skills, search, sort]);

  const selectedKey: string | null = (() => {
    if (!pane || pane.mode === "loading" || pane.mode === "create") return null;
    return "doc" in pane ? pane.doc.key : null;
  })();

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <section className="page-shell">

      {/* ── Delete confirm modal ── */}
      {deleteKey && (
        <div className="modal-backdrop" onClick={() => setDeleteKey(null)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="del-skill-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="del-skill-title" style={{ margin: "0 0 8px", fontSize: 15 }}>
              Delete skill?
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              <strong>{deleteKey}</strong> and its instruction content will be permanently
              removed from R2. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setDeleteKey(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                style={{ background: "var(--danger)", borderColor: "#6e2020" }}
                onClick={() => void handleDelete(deleteKey)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Page header: title only — "New Skill" lives in the sidebar ── */}
      <header className="page-header">
        <div className="page-header-main">
          <h2>Skills</h2>
          <p className="subhead">
            Instruction documents injected into the agent's context on demand.
          </p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-header-secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      {/* ── Banner ── */}
      {banner && (
        <div
          className={`memory-banner memory-banner-${banner.kind === "success" ? "success" : "error"}`}
          role={banner.kind === "error" ? "alert" : "status"}
        >
          {banner.message}
        </div>
      )}

      {/* ── Two-column layout ── */}
      <div className="skills-layout">

        {/* ════ Left sidebar ════ */}
        <div className="skills-sidebar">

          {/* Sidebar header: label + count + sort + "+ New" */}
          <div className="skills-sidebar-header">
            <span className="skills-sidebar-label">Skills</span>
            {skills.length > 0 && (
              <span className="skills-sidebar-count">{skills.length}</span>
            )}
            <span className="skills-sidebar-spacer" />
            <select
              className="skills-sort-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort skills"
              title="Sort"
            >
              <option value="updatedAt">Recent</option>
              <option value="name">A–Z</option>
            </select>
            <button
              type="button"
              className="skills-new-btn"
              disabled={saving}
              onClick={() => setPane({ mode: "create" })}
            >
              + New
            </button>
          </div>

          {/* Search */}
          <div className="skills-sidebar-search-wrap">
            <svg
              className="skills-sidebar-search-icon"
              width="12" height="12"
              viewBox="0 0 256 256"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M229.66,218.34l-50.07-50.06a88.21,88.21,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z" />
            </svg>
            <input
              type="search"
              className="skills-sidebar-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills…"
              aria-label="Search skills"
            />
          </div>

          {/* Scrollable skill list */}
          <div className="skills-sidebar-list">

            {loading ? (
              /* Skeleton rows */
              <ul className="skills-list" aria-busy="true">
                {[1, 2, 3, 4].map((i) => (
                  <li key={i} style={{ padding: "8px 10px" }}>
                    <div className="tasks-skeleton-line" style={{ width: "60%", height: 13 }} />
                    <div className="tasks-skeleton-line" style={{ width: "85%", height: 11, marginTop: 5 }} />
                    <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
                      <div className="tasks-skeleton-pill" />
                      <div className="tasks-skeleton-pill" />
                    </div>
                  </li>
                ))}
              </ul>

            ) : visible.length === 0 ? (

              /* Empty / no-match state */
              <div className="skills-sidebar-empty">
                {skills.length === 0 ? (
                  <>
                    <p className="skills-sidebar-empty-title">No skills yet</p>
                    <p className="skills-sidebar-empty-desc">
                      Create your first skill to give the agent reusable instructions.
                    </p>
                    <button
                      type="button"
                      className="skills-new-btn"
                      style={{ marginTop: 4 }}
                      onClick={() => setPane({ mode: "create" })}
                    >
                      + New skill
                    </button>
                  </>
                ) : (
                  <>
                    <p className="skills-sidebar-empty-title">No matches</p>
                    <p className="skills-sidebar-empty-desc">
                      No skills match "{search}".
                    </p>
                    <button
                      type="button"
                      className="btn-header-secondary"
                      style={{ marginTop: 4, fontSize: 11 }}
                      onClick={() => setSearch("")}
                    >
                      Clear search
                    </button>
                  </>
                )}
              </div>

            ) : (

              /* Skill list */
              <ul className="skills-list" aria-label="Skill list">
                {visible.map((skill) => (
                  <SkillRow
                    key={skill.key}
                    skill={skill}
                    isSelected={skill.key === selectedKey}
                    isLoaded={loadedKeys.has(skill.key)}
                    busy={saving}
                    onSelect={(key) => void openPaneFor(key, "preview")}
                    onDelete={(key) => setDeleteKey(key)}
                  />
                ))}
              </ul>

            )}
          </div>
        </div>

        {/* ════ Right pane ════ */}
        <SkillDrawer
          target={pane}
          saving={saving}
          onSave={(key, data) => void handleSave(key, data)}
          onClose={() => setPane(undefined)}
          onEditFromPreview={(doc) => setPane({ mode: "edit", doc })}
          isLoaded={selectedKey ? loadedKeys.has(selectedKey) : false}
          onLoadIntoSession={onLoadIntoSession}
          onUnloadFromSession={onUnloadFromSession}
        />

      </div>

    </section>
  );
}
