import { useState, useEffect, useRef } from "react";
import type { MemoryBlock } from "../../types/memory";
import { ConfirmDialog } from "./ConfirmDialog";

interface MemoryBlockEditorProps {
  block: MemoryBlock | null;
  isSaving: boolean;
  onSave: (label: string, content: string) => void;
  onAppend: (label: string, content: string) => void;
  onDelete: (label: string) => void;
}

export function MemoryBlockEditor({
  block,
  isSaving,
  onSave,
  onAppend,
  onDelete,
}: MemoryBlockEditorProps) {
  const [draft, setDraft] = useState("");
  const [appendText, setAppendText] = useState("");
  const [showAppend, setShowAppend] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDirty = block !== null && draft !== block.content;
  const prevLabelRef = useRef<string | null>(null);

  // Reset draft when selected block changes.
  useEffect(() => {
    if (block?.label !== prevLabelRef.current) {
      setDraft(block?.content ?? "");
      setAppendText("");
      setShowAppend(false);
      prevLabelRef.current = block?.label ?? null;
    }
  }, [block]);

  if (!block) {
    return (
      <div className="memory-editor-empty">
        <p>Select a block on the left to inspect or edit its content.</p>
      </div>
    );
  }

  function handleSave() {
    if (!block) return;
    onSave(block.label, draft);
  }

  function handleReset() {
    setDraft(block?.content ?? "");
  }

  function handleAppendSubmit() {
    if (!block || !appendText.trim()) return;
    onAppend(block.label, appendText);
    setAppendText("");
    setShowAppend(false);
  }

  return (
    <div className="memory-editor">
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete block "${block.label}"?`}
          message="This will permanently remove the memory block. This cannot be undone."
          confirmLabel="Delete block"
          danger
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(block.label);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {/* Header */}
      <div className="memory-editor-head">
        <div>
          <p className="memory-editor-label">{block.label}</p>
          {block.description && (
            <p className="memory-editor-desc">{block.description}</p>
          )}
        </div>
        <div className="memory-editor-head-actions">
          {block.isWritable !== false && (
            <button
              type="button"
              className="btn-header-secondary"
              onClick={() => setConfirmDelete(true)}
              style={{ color: "var(--danger)" }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Metadata pills */}
      <div className="memory-editor-meta">
        {block.provider && (
          <span className="memory-chip">{block.provider}</span>
        )}
        {block.maxTokens && (
          <span className="memory-chip">max {block.maxTokens} tokens</span>
        )}
        {block.isWritable === false && (
          <span className="memory-chip memory-chip-locked">Read-only</span>
        )}
        {block.updatedAt && (
          <span className="memory-chip-plain">
            Updated {new Date(block.updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Content editor */}
      <textarea
        className="memory-editor-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={block.isWritable === false}
        aria-label={`Content for ${block.label}`}
        rows={14}
        spellCheck={false}
      />

      {/* Primary actions */}
      {block.isWritable !== false && (
        <div className="memory-editor-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={!isDirty || isSaving}
            onClick={handleSave}
          >
            {isSaving ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            className="btn-header-secondary"
            disabled={!isDirty || isSaving}
            onClick={handleReset}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn-header-secondary"
            onClick={() => setShowAppend((v) => !v)}
          >
            {showAppend ? "Cancel append" : "Append"}
          </button>
        </div>
      )}

      {/* Append panel */}
      {showAppend && block.isWritable !== false && (
        <div className="memory-append-panel">
          <p className="memory-append-label">Append text to this block:</p>
          <textarea
            className="memory-editor-textarea"
            value={appendText}
            onChange={(e) => setAppendText(e.target.value)}
            rows={4}
            placeholder="Enter text to append…"
          />
          <div className="memory-editor-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn-primary"
              disabled={!appendText.trim() || isSaving}
              onClick={handleAppendSubmit}
            >
              {isSaving ? "Appending…" : "Append"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
