import type { MemoryBlock } from "../../types/memory";

interface MemoryBlockListProps {
  blocks: MemoryBlock[];
  selectedLabel: string | null;
  searchQuery: string;
  isLoading: boolean;
  onSelect: (label: string) => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  sqlite: "SQLite",
  "durable-object": "DO",
  custom: "Custom",
};

function charCount(content: string): string {
  const n = content.length;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K chars`;
  return `${n} chars`;
}

export function MemoryBlockList({
  blocks,
  selectedLabel,
  searchQuery,
  isLoading,
  onSelect,
}: MemoryBlockListProps) {
  const query = searchQuery.trim().toLowerCase();
  const filtered = query
    ? blocks.filter(
        (b) =>
          b.label.toLowerCase().includes(query) ||
          (b.description ?? "").toLowerCase().includes(query) ||
          b.content.toLowerCase().includes(query)
      )
    : blocks;

  if (isLoading) {
    return (
      <ul className="memory-block-list" aria-label="Memory blocks">
        {[1, 2, 3].map((i) => (
          <li key={i} className="memory-block-item memory-skeleton" style={{ height: 58 }} />
        ))}
      </ul>
    );
  }

  if (filtered.length === 0) {
    return (
      <ul className="memory-block-list" aria-label="Memory blocks">
        <li className="memory-block-empty">
          {query ? `No blocks match "${searchQuery}"` : "No memory blocks found."}
        </li>
      </ul>
    );
  }

  return (
    <ul className="memory-block-list" aria-label="Memory blocks">
      {filtered.map((block) => {
        const isActive = block.label === selectedLabel;
        return (
          <li key={block.label}>
            <button
              type="button"
              className={`memory-block-item${isActive ? " is-selected" : ""}${!block.isWritable ? " is-readonly" : ""}`}
              onClick={() => onSelect(block.label)}
              aria-pressed={isActive}
            >
              <span className="memory-block-label">{block.label}</span>
              {block.description && (
                <span className="memory-block-desc">{block.description}</span>
              )}
              <span className="memory-block-meta-row">
                <span className="memory-block-chars">{charCount(block.content)}</span>
                {block.provider && (
                  <span className="memory-chip">{PROVIDER_LABELS[block.provider] ?? block.provider}</span>
                )}
                {!block.isWritable && (
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
