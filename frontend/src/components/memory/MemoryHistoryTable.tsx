import { useState, useMemo } from "react";
import type { MemoryMessage } from "../../types/memory";
import { ConfirmDialog } from "./ConfirmDialog";

interface MemoryHistoryTableProps {
  messages: MemoryMessage[];
  isLoading: boolean;
  searchQuery: string;
  onDeleteSelected: (ids: string[]) => void;
  onClearAll: (sessionId?: string) => void;
}

type RoleFilter = "all" | MemoryMessage["role"];

const ROLE_LABELS: Record<string, string> = {
  all: "All roles",
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
};

function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function MemoryHistoryTable({
  messages,
  isLoading,
  searchQuery,
  onDeleteSelected,
  onClearAll,
}: MemoryHistoryTableProps) {
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteSel, setConfirmDeleteSel] = useState(false);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return messages.filter((m) => {
      if (roleFilter !== "all" && m.role !== roleFilter) return false;
      if (query && !m.content.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [messages, roleFilter, searchQuery]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((m) => m.id)));
    }
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = filtered.length > 0 && selectedIds.size === filtered.length;

  if (isLoading) {
    return (
      <div style={{ padding: "12px 0" }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="memory-skeleton" style={{ height: 36, marginBottom: 6, borderRadius: 8 }} />
        ))}
      </div>
    );
  }

  return (
    <>
      {confirmClear && (
        <ConfirmDialog
          title="Clear session history?"
          message="This will permanently delete all messages from the agent's memory. This cannot be undone."
          confirmLabel="Clear history"
          danger
          onConfirm={() => {
            setConfirmClear(false);
            setSelectedIds(new Set());
            onClearAll();
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
      {confirmDeleteSel && (
        <ConfirmDialog
          title={`Delete ${selectedIds.size} message${selectedIds.size !== 1 ? "s" : ""}?`}
          message="The selected messages will be permanently removed from memory."
          confirmLabel="Delete messages"
          danger
          onConfirm={() => {
            setConfirmDeleteSel(false);
            onDeleteSelected([...selectedIds]);
            setSelectedIds(new Set());
          }}
          onCancel={() => setConfirmDeleteSel(false)}
        />
      )}

      {/* Toolbar */}
      <div className="memory-history-toolbar">
        <select
          className="memory-filter-select"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
          aria-label="Filter by role"
        >
          {(Object.keys(ROLE_LABELS) as RoleFilter[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>

        <span className="memory-history-count muted">
          {filtered.length} of {messages.length} messages
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {selectedIds.size > 0 && (
            <button
              type="button"
              className="btn-header-secondary"
              style={{ color: "var(--danger)" }}
              onClick={() => setConfirmDeleteSel(true)}
            >
              Delete {selectedIds.size} selected
            </button>
          )}
          <button
            type="button"
            className="btn-header-secondary"
            style={{ color: "var(--danger)" }}
            onClick={() => setConfirmClear(true)}
            disabled={messages.length === 0}
          >
            Clear all
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, padding: "12px 0" }}>
          {messages.length === 0 ? "No message history found." : "No messages match the current filter."}
        </p>
      ) : (
        <table className="memory-history-table">
          <thead>
            <tr>
              <th className="memory-th-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="memory-th-role">Role</th>
              <th className="memory-th-content">Content</th>
              <th className="memory-th-date">Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((msg) => {
              const isExpanded = expandedIds.has(msg.id);
              const isChecked = selectedIds.has(msg.id);
              const isLong = msg.content.length > 120;
              return (
                <tr
                  key={msg.id}
                  className={`memory-history-row${isChecked ? " is-selected" : ""}`}
                >
                  <td className="memory-td-check">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelect(msg.id)}
                      aria-label={`Select message ${msg.id}`}
                    />
                  </td>
                  <td className="memory-td-role">
                    <span className={`memory-role-badge memory-role-${msg.role}`}>
                      {msg.role}
                    </span>
                  </td>
                  <td className="memory-td-content">
                    <span className="memory-message-text">
                      {isExpanded ? msg.content : truncate(msg.content)}
                    </span>
                    {isLong && (
                      <button
                        type="button"
                        className="memory-expand-btn"
                        onClick={() => toggleExpand(msg.id)}
                      >
                        {isExpanded ? "Show less" : "Show more"}
                      </button>
                    )}
                  </td>
                  <td className="memory-td-date">{fmtDate(msg.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
