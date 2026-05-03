import type { ContextEventAction, ContextEventItem } from "../../types";

interface ContextEventRowProps {
  item: ContextEventItem;
}

function actionLabel(action: ContextEventAction, skillName: string): string {
  switch (action) {
    case "load":
      return `Loaded skill: ${skillName}`;
    case "unload":
      return `Unloaded skill: ${skillName}`;
    case "update":
      return `Updated skill: ${skillName}`;
    case "create":
      return `Created skill: ${skillName}`;
    case "delete":
      return `Deleted skill: ${skillName}`;
  }
}

function ActionIcon({ action }: { action: ContextEventAction }) {
  switch (action) {
    case "load":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 2h5l3 3v5H2V2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" fill="none" />
          <path d="M7 2v3h3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
          <path d="M4.5 8h3M6 6.5v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      );
    case "unload":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 2h5l3 3v5H2V2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" fill="none" />
          <path d="M7 2v3h3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
          <path d="M4.5 8h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      );
    case "update":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 2h5l3 3v5H2V2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" fill="none" />
          <path d="M7 2v3h3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
          <path d="M3.5 7.5L5 6l1.5 1.5L8 5.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 2h5l3 3v5H2V2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" fill="none" />
          <path d="M7 2v3h3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        </svg>
      );
  }
}

export function ContextEventRow({ item }: ContextEventRowProps) {
  return (
    <div className="context-event-row" aria-label={actionLabel(item.action, item.skillName)}>
      <div className="context-event-row-main">
        <span className="context-event-row-line" aria-hidden="true" />
        <span className="context-event-row-label">
          <span className="context-event-row-icon">
            <ActionIcon action={item.action} />
          </span>
          {actionLabel(item.action, item.skillName)}
        </span>
        <span className="context-event-row-line" aria-hidden="true" />
      </div>
      {item.description && (
        <p className="context-event-row-desc">{item.description}</p>
      )}
    </div>
  );
}
