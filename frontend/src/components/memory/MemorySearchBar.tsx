interface MemorySearchBarProps {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

export function MemorySearchBar({ value, placeholder = "Search…", onChange }: MemorySearchBarProps) {
  return (
    <div className="memory-search-wrap">
      <span className="memory-search-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="6.5" cy="6.5" r="5" />
          <path d="M11 11l3.5 3.5" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        className="memory-search-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder}
      />
      {value && (
        <button
          type="button"
          className="memory-search-clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          ×
        </button>
      )}
    </div>
  );
}
