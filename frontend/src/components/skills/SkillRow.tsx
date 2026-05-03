import type { SkillSummary } from "../../types/skills";

// ── Props ─────────────────────────────────────────────────────────────────────

interface SkillRowProps {
  skill:      SkillSummary;
  isSelected: boolean;
  busy:       boolean;
  /** True when the agent has this skill loaded in its current context window. */
  isLoaded?:  boolean;
  /** Clicking the card body opens the skill in the right pane (preview mode). */
  onSelect:   (key: string) => void;
  /** Triggered by the hover-reveal × button; caller shows a confirm dialog. */
  onDelete:   (key: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SkillRow({ skill, isSelected, busy, isLoaded, onSelect, onDelete }: SkillRowProps) {
  return (
    <li>
      <button
        type="button"
        className={`skills-row${isSelected ? " is-selected" : ""}${isLoaded ? " is-loaded" : ""}`}
        onClick={() => onSelect(skill.key)}
        disabled={busy}
        aria-pressed={isSelected}
        aria-label={skill.name}
      >
        {/* ── Name + loaded badge + hover-reveal delete ── */}
        <div className="skills-row-header">
          <span className="skills-row-name">{skill.name}</span>
          {isLoaded && (
            <span className="skill-loaded-badge" aria-label="Currently in agent context">
              In session
            </span>
          )}
          <button
            type="button"
            className="skills-row-delete"
            onClick={(e) => { e.stopPropagation(); onDelete(skill.key); }}
            disabled={busy}
            aria-label={`Delete ${skill.name}`}
            tabIndex={-1}
          >
            ×
          </button>
        </div>

        {/* ── Description ── */}
        {skill.description && (
          <span className="skills-row-desc">{skill.description}</span>
        )}

        {/* ── Tags + date ── */}
        {(skill.tags.length > 0 || skill.updatedAt) && (
          <div className="skills-row-meta">
            {skill.tags.map((tag) => (
              <span key={tag} className="skills-tag">{tag}</span>
            ))}
            <span className="skills-row-date">{fmtDate(skill.updatedAt)}</span>
          </div>
        )}
      </button>
    </li>
  );
}
