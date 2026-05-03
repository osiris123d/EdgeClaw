// ── Core domain types ────────────────────────────────────────────────────────

export interface MemoryBlock {
  label: string;
  description?: string;
  content: string;
  maxTokens?: number;
  updatedAt?: string;
  provider?: "sqlite" | "durable-object" | "custom";
  isWritable?: boolean;
}

export interface MemoryBlockSummary {
  label: string;
  description?: string;
  /** Rough character count of stored content. */
  charCount: number;
  updatedAt?: string;
  provider?: "sqlite" | "durable-object" | "custom";
  isWritable?: boolean;
}

export interface MemoryMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  sessionId?: string;
  createdAt?: string;
}

export interface MemoryOverview {
  totalBlocks: number;
  totalMessages: number;
  estimatedChars: number;
  lastUpdatedAt?: string;
}

export interface MemorySearchResult {
  blocks: MemoryBlock[];
  messages: MemoryMessage[];
}

export interface MemoryPageState {
  blocks: MemoryBlock[];
  messages: MemoryMessage[];
  selectedBlockLabel: string | null;
  activeTab: "blocks" | "history" | "advanced";
  searchQuery: string;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  successMessage: string | null;
}

// ── API request / response shapes ────────────────────────────────────────────

export interface GetMemoryResponse {
  overview: MemoryOverview;
  blocks: MemoryBlock[];
  messages?: MemoryMessage[];
}

export interface ReplaceMemoryBlockRequest {
  label: string;
  content: string;
}

export interface AppendMemoryBlockRequest {
  label: string;
  content: string;
}

export interface DeleteMemoryBlockRequest {
  label: string;
}

export interface DeleteMessagesRequest {
  /** Message IDs to delete. */
  ids: string[];
}

export interface ClearHistoryRequest {
  /** When provided, only messages belonging to this session are cleared. */
  sessionId?: string;
}
