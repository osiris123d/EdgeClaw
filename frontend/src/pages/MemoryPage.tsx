import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { MemoryBlock, MemoryMessage, MemoryOverview } from "../types/memory";
import {
  getMemory,
  replaceBlock,
  appendBlock,
  deleteBlock,
  refreshPrompt,
  deleteMessages,
  clearHistory,
} from "../lib/memoryApi";
import { MemoryOverviewCards } from "../components/memory/MemoryOverviewCards";
import { MemorySearchBar } from "../components/memory/MemorySearchBar";

// ── Types ─────────────────────────────────────────────────────────────────────

type ActiveTab = "blocks" | "history" | "advanced";
type RoleFilter = "all" | MemoryMessage["role"];

type ConfirmDialog =
  | { type: "deleteBlock"; label: string }
  | { type: "clearHistory" }
  | { type: "deleteMessages"; ids: string[] };

interface NewBlockDraft {
  label: string;
  content: string;
  description: string;
}

interface PageState {
  blocks: MemoryBlock[];
  messages: MemoryMessage[];
  selectedBlockLabel: string | null;
  activeTab: ActiveTab;
  searchQuery: string;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  successMessage: string | null;
  rawJsonExpanded: boolean;
  confirmDialog: ConfirmDialog | null;
}

// endpoint prop retained for potential multi-agent routing
interface MemoryPageProps {
  endpoint?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY_OVERVIEW: MemoryOverview = {
  totalBlocks: 0,
  totalMessages: 0,
  estimatedChars: 0,
};

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "blocks", label: "Blocks" },
  { id: "history", label: "History" },
  { id: "advanced", label: "Advanced" },
];

const ROLE_FILTERS: { value: RoleFilter; label: string }[] = [
  { value: "all", label: "All roles" },
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" },
  { value: "system", label: "System" },
  { value: "tool", label: "Tool" },
];

// ── Small helpers ─────────────────────────────────────────────────────────────

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

function fmtChars(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K chars`;
  return `${n} char${n !== 1 ? "s" : ""}`;
}

function truncate(text: string, max = 140): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── useFlash hook ─────────────────────────────────────────────────────────────

function useFlash(setState: React.Dispatch<React.SetStateAction<PageState>>) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (message: string, isError = false) => {
      if (timer.current) clearTimeout(timer.current);
      setState((s) => ({
        ...s,
        successMessage: isError ? null : message,
        error: isError ? message : null,
      }));
      timer.current = setTimeout(
        () => setState((s) => ({ ...s, successMessage: null, error: null })),
        3500
      );
    },
    [setState]
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MemoryPage
// ══════════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MemoryPage(_props: MemoryPageProps) {
  const [state, setState] = useState<PageState>({
    blocks: [],
    messages: [],
    selectedBlockLabel: null,
    activeTab: "blocks",
    searchQuery: "",
    isLoading: false,
    isSaving: false,
    error: null,
    successMessage: null,
    rawJsonExpanded: false,
    confirmDialog: null,
  });

  const [overview, setOverview] = useState<MemoryOverview>(EMPTY_OVERVIEW);
  const [rawJson, setRawJson] = useState("");
  const [isRefreshingPrompt, setIsRefreshingPrompt] = useState(false);

  // Block editor local draft
  const [draft, setDraft] = useState("");
  const [appendText, setAppendText] = useState("");
  const [showAppend, setShowAppend] = useState(false);
  const draftLabelRef = useRef<string | null>(null);

  // New block form
  const [newBlockMode, setNewBlockMode] = useState(false);
  const [newBlock, setNewBlock] = useState<NewBlockDraft>({ label: "", content: "", description: "" });

  // History selection & role filter
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());

  const flash = useFlash(setState);

  // ── Load ───────────────────────────────────────────────────────────────────

  const load = useCallback(async (signal?: AbortSignal) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const data = await getMemory(signal);
      const blocks: MemoryBlock[] = data.blocks ?? [];
      const messages: MemoryMessage[] = data.messages ?? [];

      setOverview(data.overview ?? EMPTY_OVERVIEW);
      setRawJson(JSON.stringify(data, null, 2));
      setState((s) => ({
        ...s,
        blocks,
        messages,
        isLoading: false,
        selectedBlockLabel:
          s.selectedBlockLabel && blocks.some((b) => b.label === s.selectedBlockLabel)
            ? s.selectedBlockLabel
            : (blocks[0]?.label ?? null),
      }));
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load memory.",
      }));
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  // Sync editor draft when selected block changes
  useEffect(() => {
    const block = state.blocks.find((b) => b.label === state.selectedBlockLabel) ?? null;
    if (block?.label !== draftLabelRef.current) {
      setDraft(block?.content ?? "");
      setAppendText("");
      setShowAppend(false);
      draftLabelRef.current = block?.label ?? null;
    }
  }, [state.selectedBlockLabel, state.blocks]);

  // ── Apply response ─────────────────────────────────────────────────────────

  function applyResponse(data: Awaited<ReturnType<typeof getMemory>>) {
    const blocks: MemoryBlock[] = data.blocks ?? [];
    const messages: MemoryMessage[] = data.messages ?? [];
    if (data.overview) setOverview(data.overview);
    setRawJson(JSON.stringify(data, null, 2));
    setState((s) => ({
      ...s,
      blocks,
      messages,
      confirmDialog: null,
      selectedBlockLabel:
        s.selectedBlockLabel && blocks.some((b) => b.label === s.selectedBlockLabel)
          ? s.selectedBlockLabel
          : (blocks[0]?.label ?? null),
    }));
  }

  // ── Block actions ──────────────────────────────────────────────────────────

  async function handleSave() {
    const label = state.selectedBlockLabel;
    if (!label) return;
    setState((s) => ({ ...s, isSaving: true }));
    try {
      const data = await replaceBlock(label, draft);
      applyResponse(data);
      // Sync draft to what the server stored (guards against server-side transforms)
      const saved = (data.blocks ?? []).find((b) => b.label === label);
      if (saved) setDraft(saved.content);
      flash("Block saved.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Save failed.", true);
    } finally {
      setState((s) => ({ ...s, isSaving: false }));
    }
  }

  async function handleAppendSubmit() {
    const label = state.selectedBlockLabel;
    if (!label || !appendText.trim()) return;
    setState((s) => ({ ...s, isSaving: true }));
    try {
      const data = await appendBlock(label, appendText);
      applyResponse(data);
      // Sync draft to the merged server content so isDraftDirty stays false
      const updated = (data.blocks ?? []).find((b) => b.label === label);
      if (updated) {
        setDraft(updated.content);
        draftLabelRef.current = label;
      }
      setAppendText("");
      setShowAppend(false);
      flash("Content appended.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Append failed.", true);
    } finally {
      setState((s) => ({ ...s, isSaving: false }));
    }
  }

  async function handleDeleteBlock(label: string) {
    setState((s) => ({ ...s, isSaving: true, confirmDialog: null }));
    try {
      applyResponse(await deleteBlock(label));
      flash("Block deleted.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Delete failed.", true);
    } finally {
      setState((s) => ({ ...s, isSaving: false }));
    }
  }

  async function handleCreateBlock() {
    const { label, content } = newBlock;
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;
    // Prevent silent overwrite of an existing block
    if (state.blocks.some((b) => b.label === trimmedLabel)) {
      flash(`A block named "${trimmedLabel}" already exists. Select it and use Save changes to edit.`, true);
      return;
    }
    setState((s) => ({ ...s, isSaving: true }));
    try {
      applyResponse(await replaceBlock(trimmedLabel, content));
      setNewBlockMode(false);
      setNewBlock({ label: "", content: "", description: "" });
      setState((s) => ({ ...s, selectedBlockLabel: trimmedLabel }));
      flash(`Block "${trimmedLabel}" created.`);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Create failed.", true);
    } finally {
      setState((s) => ({ ...s, isSaving: false }));
    }
  }

  // ── Message actions ────────────────────────────────────────────────────────

  async function handleDeleteMessages(ids: string[]) {
    setState((s) => ({ ...s, confirmDialog: null }));
    try {
      applyResponse(await deleteMessages(ids));
      setSelectedMsgIds(new Set());
      flash(`${ids.length} message${ids.length !== 1 ? "s" : ""} deleted.`);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Delete failed.", true);
    }
  }

  async function handleClearHistory() {
    setState((s) => ({ ...s, confirmDialog: null }));
    try {
      applyResponse(await clearHistory());
      setSelectedMsgIds(new Set());
      flash("History cleared.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Clear failed.", true);
    }
  }

  // ── Refresh prompt ─────────────────────────────────────────────────────────

  async function handleRefreshPrompt() {
    setIsRefreshingPrompt(true);
    try {
      await refreshPrompt();
      flash("System prompt refreshed.");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Refresh failed.", true);
    } finally {
      setIsRefreshingPrompt(false);
    }
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  function handleExport() {
    const json = rawJson || JSON.stringify({ blocks: state.blocks, messages: state.messages }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `memory-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Derived / memos ────────────────────────────────────────────────────────

  const selectedBlock = useMemo(
    () => state.blocks.find((b) => b.label === state.selectedBlockLabel) ?? null,
    [state.blocks, state.selectedBlockLabel]
  );

  const isDraftDirty = selectedBlock !== null && draft !== selectedBlock.content;

  const filteredBlocks = useMemo(() => {
    const q = state.searchQuery.trim().toLowerCase();
    if (!q) return state.blocks;
    return state.blocks.filter(
      (b) =>
        b.label.toLowerCase().includes(q) ||
        (b.description ?? "").toLowerCase().includes(q) ||
        b.content.toLowerCase().includes(q)
    );
  }, [state.blocks, state.searchQuery]);

  const filteredMessages = useMemo(() => {
    const q = state.searchQuery.trim().toLowerCase();
    return state.messages.filter((m) => {
      if (roleFilter !== "all" && m.role !== roleFilter) return false;
      if (q && !m.content.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [state.messages, state.searchQuery, roleFilter]);

  const allMessagesSelected =
    filteredMessages.length > 0 && filteredMessages.every((m) => selectedMsgIds.has(m.id));

  // ── Confirm dialog ─────────────────────────────────────────────────────────

  function renderConfirmDialog() {
    const { confirmDialog } = state;
    if (!confirmDialog) return null;

    let title = "";
    let message = "";
    let confirmLabel = "Confirm";

    if (confirmDialog.type === "deleteBlock") {
      title = `Delete block "${confirmDialog.label}"?`;
      message = "This permanently removes the memory block and its content. This cannot be undone.";
      confirmLabel = "Delete block";
    } else if (confirmDialog.type === "clearHistory") {
      title = "Clear all message history?";
      message =
        "Every message in the conversation will be permanently deleted. Memory blocks (like preferences and notes) will not be affected — only the message history is cleared.";
      confirmLabel = "Clear messages";
    } else if (confirmDialog.type === "deleteMessages") {
      const n = confirmDialog.ids.length;
      title = `Delete ${n} message${n !== 1 ? "s" : ""}?`;
      message = "The selected messages will be permanently removed from memory.";
      confirmLabel = `Delete ${n} message${n !== 1 ? "s" : ""}`;
    }

    const onConfirm = () => {
      if (confirmDialog.type === "deleteBlock") void handleDeleteBlock(confirmDialog.label);
      else if (confirmDialog.type === "clearHistory") void handleClearHistory();
      else if (confirmDialog.type === "deleteMessages") void handleDeleteMessages(confirmDialog.ids);
    };

    return (
      <div
        className="modal-backdrop"
        onClick={() => setState((s) => ({ ...s, confirmDialog: null }))}
      >
        <div
          className="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 id="confirm-title" style={{ margin: "0 0 8px", fontSize: 16 }}>
            {title}
          </h3>
          <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
            {message}
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setState((s) => ({ ...s, confirmDialog: null }))}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              style={{ background: "var(--danger)", borderColor: "#6e2020" }}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Blocks tab ─────────────────────────────────────────────────────────────

  function renderBlocksList() {
    if (state.isLoading) {
      return (
        <ul className="memory-block-list" aria-label="Memory blocks">
          {[1, 2, 3].map((i) => (
            <li key={i} className="memory-skeleton" style={{ height: 58, borderRadius: 8 }} />
          ))}
        </ul>
      );
    }

    if (filteredBlocks.length === 0) {
      return (
        <p className="memory-block-empty muted">
          {state.searchQuery ? `No blocks match "${state.searchQuery}".` : "No memory blocks yet."}
        </p>
      );
    }

    return (
      <ul className="memory-block-list" aria-label="Memory blocks">
        {filteredBlocks.map((block) => {
          const isActive = block.label === state.selectedBlockLabel;
          return (
            <li key={block.label}>
              <button
                type="button"
                className={`memory-block-item${isActive ? " is-selected" : ""}${block.isWritable === false ? " is-readonly" : ""}`}
                onClick={() => setState((s) => ({ ...s, selectedBlockLabel: block.label }))}
                aria-pressed={isActive}
              >
                <span className="memory-block-label">{block.label}</span>
                {block.description && (
                  <span className="memory-block-desc">{block.description}</span>
                )}
                <span className="memory-block-meta-row">
                  <span className="memory-block-chars">{fmtChars(block.content.length)}</span>
                  {block.provider && <span className="memory-chip">{block.provider}</span>}
                  {block.isWritable === false && (
                    <span className="memory-chip memory-chip-locked">Read-only</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  function renderNewBlockForm() {
    if (!newBlockMode) return null;
    return (
      <div className="memory-advanced-section" style={{ marginBottom: 0 }}>
        <h3 className="memory-advanced-section-title" style={{ marginBottom: 10 }}>
          New block
        </h3>
        <div style={{ display: "grid", gap: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>
            Label *
            <input
              type="text"
              className="memory-editor-textarea"
              style={{ display: "block", width: "100%", marginTop: 4, padding: "7px 10px", fontFamily: "inherit", fontSize: 13 }}
              value={newBlock.label}
              onChange={(e) => setNewBlock((nb) => ({ ...nb, label: e.target.value }))}
              placeholder="e.g. preferences, workspace, user-profile"
              aria-required="true"
            />
          </label>
          <label style={{ fontSize: 12, fontWeight: 600 }}>
            Initial content
            <textarea
              className="memory-editor-textarea"
              style={{ display: "block", width: "100%", marginTop: 4 }}
              rows={4}
              value={newBlock.content}
              onChange={(e) => setNewBlock((nb) => ({ ...nb, content: e.target.value }))}
              placeholder="Enter initial content for this block…"
            />
          </label>
        </div>
        <div className="memory-editor-actions" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn-primary"
            disabled={!newBlock.label.trim() || state.isSaving}
            onClick={() => void handleCreateBlock()}
          >
            {state.isSaving ? "Creating…" : "Create block"}
          </button>
          <button
            type="button"
            className="btn-header-secondary"
            onClick={() => {
              setNewBlockMode(false);
              setNewBlock({ label: "", content: "", description: "" });
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderBlockEditor() {
    if (!selectedBlock) {
      return (
        <div className="memory-editor-empty">
          <p className="muted">
            {state.blocks.length === 0
              ? "No blocks yet — create one with \"New block\"."
              : "Select a block on the left to inspect or edit its content."}
          </p>
        </div>
      );
    }

    const readonly = selectedBlock.isWritable === false;

    return (
      <div className="memory-editor">
        {/* Block header */}
        <div className="memory-editor-head">
          <div>
            <p className="memory-editor-label">{selectedBlock.label}</p>
            {selectedBlock.description && (
              <p className="memory-editor-desc">{selectedBlock.description}</p>
            )}
          </div>
          {!readonly && (
            <button
              type="button"
              className="btn-header-secondary"
              style={{ color: "var(--danger)", flexShrink: 0 }}
              disabled={state.isSaving}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  confirmDialog: { type: "deleteBlock", label: selectedBlock.label },
                }))
              }
            >
              Delete
            </button>
          )}
        </div>

        {/* Metadata pills */}
        <div className="memory-editor-meta">
          {selectedBlock.provider && (
            <span className="memory-chip">{selectedBlock.provider}</span>
          )}
          {selectedBlock.maxTokens != null && (
            <span className="memory-chip">max {selectedBlock.maxTokens} tokens</span>
          )}
          {readonly && (
            <span className="memory-chip memory-chip-locked">Read-only</span>
          )}
          {selectedBlock.updatedAt && (
            <span className="memory-chip-plain">
              Updated {fmtDate(selectedBlock.updatedAt)}
            </span>
          )}
        </div>

        {/* Content textarea */}
        <textarea
          className="memory-editor-textarea"
          rows={14}
          value={draft}
          readOnly={readonly}
          aria-label={`Content for ${selectedBlock.label}`}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />

        {/* Primary actions */}
        {!readonly && (
          <div className="memory-editor-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={!isDraftDirty || state.isSaving}
              onClick={() => void handleSave()}
            >
              {state.isSaving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              className="btn-header-secondary"
              disabled={!isDraftDirty || state.isSaving}
              onClick={() => setDraft(selectedBlock.content)}
            >
              Reset
            </button>
            <button
              type="button"
              className="btn-header-secondary"
              disabled={state.isSaving}
              onClick={() => setShowAppend((v) => !v)}
            >
              {showAppend ? "Cancel append" : "Append"}
            </button>
          </div>
        )}

        {/* Append sub-form */}
        {showAppend && !readonly && (
          <div className="memory-append-panel">
            <p className="memory-append-label">Text to append:</p>
            <textarea
              className="memory-editor-textarea"
              rows={4}
              value={appendText}
              onChange={(e) => setAppendText(e.target.value)}
              placeholder="Enter text to append to this block…"
              aria-label="Text to append"
            />
            <div className="memory-editor-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn-primary"
                disabled={!appendText.trim() || state.isSaving}
                onClick={() => void handleAppendSubmit()}
              >
                {state.isSaving ? "Appending…" : "Append"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderBlocksTab() {
    return (
      <div className="memory-blocks-layout">
        {/* Left column */}
        <div className="memory-blocks-left">
          <MemorySearchBar
            value={state.searchQuery}
            placeholder="Search blocks…"
            onChange={(q) => setState((s) => ({ ...s, searchQuery: q }))}
          />
          {renderBlocksList()}
        </div>

        {/* Right column */}
        <div className="memory-blocks-right">
          {newBlockMode ? renderNewBlockForm() : renderBlockEditor()}
        </div>
      </div>
    );
  }

  // ── History tab ────────────────────────────────────────────────────────────

  function renderHistoryTab() {
    function toggleSelectAll() {
      if (allMessagesSelected) {
        setSelectedMsgIds(new Set());
      } else {
        setSelectedMsgIds(new Set(filteredMessages.map((m) => m.id)));
      }
    }

    function toggleMsg(id: string) {
      setSelectedMsgIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }

    function toggleExpand(id: string) {
      setExpandedMsgIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }

    return (
      <div className="memory-history-layout">
        {/* Search + filters */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
          <MemorySearchBar
            value={state.searchQuery}
            placeholder="Search messages…"
            onChange={(q) => setState((s) => ({ ...s, searchQuery: q }))}
          />
          <select
            className="memory-filter-select"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            aria-label="Filter by role"
          >
            {ROLE_FILTERS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* Toolbar */}
        <div className="memory-history-toolbar">
          <span className="muted" style={{ fontSize: 12 }}>
            {filteredMessages.length} of {state.messages.length} messages
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {selectedMsgIds.size > 0 && (
              <button
                type="button"
                className="btn-header-secondary"
                style={{ color: "var(--danger)" }}
                onClick={() =>
                  setState((s) => ({
                    ...s,
                    confirmDialog: { type: "deleteMessages", ids: [...selectedMsgIds] },
                  }))
                }
              >
                Delete {selectedMsgIds.size} selected
              </button>
            )}
            <button
              type="button"
              className="btn-header-secondary"
              style={{ color: "var(--danger)" }}
              disabled={state.messages.length === 0}
              onClick={() =>
                setState((s) => ({ ...s, confirmDialog: { type: "clearHistory" } }))
              }
            >
              Clear history
            </button>
          </div>
        </div>

        {/* Message list */}
        {state.isLoading ? (
          <div style={{ display: "grid", gap: 6 }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="memory-skeleton" style={{ height: 40, borderRadius: 8 }} />
            ))}
          </div>
        ) : filteredMessages.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, padding: "12px 0" }}>
            {state.messages.length === 0
              ? "No message history found."
              : "No messages match the current filter."}
          </p>
        ) : (
          <table className="memory-history-table">
            <thead>
              <tr>
                <th className="memory-th-check">
                  <input
                    type="checkbox"
                    checked={allMessagesSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all visible messages"
                  />
                </th>
                <th className="memory-th-role">Role</th>
                <th className="memory-th-content">Content</th>
                <th className="memory-th-date">Date</th>
              </tr>
            </thead>
            <tbody>
              {filteredMessages.map((msg) => {
                const isChecked = selectedMsgIds.has(msg.id);
                const isExpanded = expandedMsgIds.has(msg.id);
                const isLong = msg.content.length > 140;
                return (
                  <tr
                    key={msg.id}
                    className={`memory-history-row${isChecked ? " is-selected" : ""}`}
                  >
                    <td className="memory-td-check">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleMsg(msg.id)}
                        aria-label={`Select message from ${msg.role}`}
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
      </div>
    );
  }

  // ── Advanced tab ───────────────────────────────────────────────────────────

  function renderAdvancedTab() {
    return (
      <div className="memory-advanced-layout">

        {/* Refresh system prompt */}
        <section className="memory-advanced-section">
          <div className="memory-advanced-section-head">
            <div>
              <h3 className="memory-advanced-section-title" style={{ marginBottom: 2 }}>
                Refresh system prompt
              </h3>
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                Asks the agent to rebuild its system prompt from current memory blocks.
              </p>
            </div>
            <button
              type="button"
              className="btn-header-secondary"
              disabled={isRefreshingPrompt}
              onClick={() => void handleRefreshPrompt()}
            >
              {isRefreshingPrompt ? "Refreshing…" : "Refresh prompt"}
            </button>
          </div>
        </section>

        {/* Raw JSON — collapsible */}
        <section className="memory-advanced-section">
          <div className="memory-advanced-section-head">
            <button
              type="button"
              className="memory-collapsible-toggle"
              aria-expanded={state.rawJsonExpanded}
              onClick={() =>
                setState((s) => ({ ...s, rawJsonExpanded: !s.rawJsonExpanded }))
              }
            >
              <span>Raw memory payload</span>
              <span
                className={`turn-caret${state.rawJsonExpanded ? " is-open" : ""}`}
                aria-hidden="true"
              >
                ▾
              </span>
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn-header-secondary"
                disabled={!rawJson}
                onClick={handleExport}
              >
                Export JSON
              </button>
              <button
                type="button"
                className="btn-header-secondary"
                disabled={state.isLoading}
                onClick={() => void load()}
              >
                Refresh
              </button>
            </div>
          </div>

          {state.rawJsonExpanded && (
            rawJson ? (
              <pre className="memory-raw-json" style={{ marginTop: 10 }}>{rawJson}</pre>
            ) : (
              <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
                {state.isLoading ? "Loading…" : "No data — click Refresh."}
              </p>
            )
          )}
        </section>

        {/* Danger zone */}
        <section className="memory-advanced-section memory-danger-zone">
          <h3 className="memory-advanced-section-title" style={{ color: "var(--danger)" }}>
            Danger zone
          </h3>
          <div className="memory-danger-row">
            <div>
              <strong style={{ fontSize: 13.5 }}>Clear all message history</strong>
              <p className="muted" style={{ fontSize: 12.5, margin: "3px 0 0" }}>
                Permanently removes every message from the conversation history. Memory blocks are not affected. This cannot be undone.
              </p>
            </div>
            <button
              type="button"
              className="btn-primary"
              style={{ background: "var(--danger)", borderColor: "#6e2020", flexShrink: 0 }}
              onClick={() =>
                setState((s) => ({ ...s, confirmDialog: { type: "clearHistory" } }))
              }
            >
              Clear history
            </button>
          </div>
        </section>

      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <section className="page-shell">
      {renderConfirmDialog()}

      {/* Header */}
      <header className="page-header">
        <div className="page-header-main">
          <h2>Memory</h2>
          <p className="subhead">
            Inspect, edit, and clear durable agent memory and session history.
          </p>
        </div>
        <div className="page-header-actions" style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn-header-secondary"
            disabled={isRefreshingPrompt}
            onClick={() => void handleRefreshPrompt()}
          >
            {isRefreshingPrompt ? "Refreshing…" : "Refresh prompt"}
          </button>
          <button
            type="button"
            className="btn-header-secondary"
            disabled={state.isLoading}
            onClick={() => void load()}
          >
            {state.isLoading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setNewBlockMode(true);
              setNewBlock({ label: "", content: "", description: "" });
              setState((s) => ({ ...s, activeTab: "blocks" }));
            }}
          >
            New block
          </button>
        </div>
      </header>

      {/* Feedback banners */}
      {state.error && (
        <div className="memory-banner memory-banner-error" role="alert">
          {state.error}
        </div>
      )}
      {state.successMessage && (
        <div className="memory-banner memory-banner-success" role="status">
          {state.successMessage}
        </div>
      )}

      {/* Overview cards */}
      <MemoryOverviewCards overview={overview} isLoading={state.isLoading} />

      {/* Tab bar */}
      <div className="memory-tab-bar" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={state.activeTab === tab.id}
            className={`memory-tab-btn${state.activeTab === tab.id ? " is-active" : ""}`}
            onClick={() =>
              setState((s) => ({
                ...s,
                activeTab: tab.id,
                searchQuery: "",
              }))
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="memory-tab-content">
        {state.activeTab === "blocks" && renderBlocksTab()}
        {state.activeTab === "history" && renderHistoryTab()}
        {state.activeTab === "advanced" && renderAdvancedTab()}
      </div>
    </section>
  );
}
