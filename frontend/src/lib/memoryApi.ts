import type {
  GetMemoryResponse,
} from "../types/memory";

const BASE = "/api/memory";

// ── Internal helper ───────────────────────────────────────────────────────────

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(
      `Network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = body;
    } catch {
      // ignore – use statusText
    }
    throw new Error(`[memoryApi] ${res.status} ${res.statusText} — ${detail}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`[memoryApi] Response from ${url} was not valid JSON`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Fetch the full memory state (overview + blocks + messages). */
export function getMemory(signal?: AbortSignal): Promise<GetMemoryResponse> {
  return requestJson<GetMemoryResponse>(BASE, { signal });
}

/** Overwrite a block's content entirely. */
export function replaceBlock(
  label: string,
  content: string,
  signal?: AbortSignal
): Promise<GetMemoryResponse> {
  return requestJson<GetMemoryResponse>(
    `${BASE}/${encodeURIComponent(label)}`,
    {
      method: "PUT",
      body: JSON.stringify({ label, content }),
      signal,
    }
  );
}

/** Append text to an existing block. */
export function appendBlock(
  label: string,
  content: string,
  signal?: AbortSignal
): Promise<GetMemoryResponse> {
  return requestJson<GetMemoryResponse>(
    `${BASE}/${encodeURIComponent(label)}/append`,
    {
      method: "POST",
      body: JSON.stringify({ label, content }),
      signal,
    }
  );
}

/** Delete a single memory block by label. */
export function deleteBlock(
  label: string,
  signal?: AbortSignal
): Promise<GetMemoryResponse> {
  return requestJson<GetMemoryResponse>(
    `${BASE}/${encodeURIComponent(label)}`,
    { method: "DELETE", signal }
  );
}

/** Ask the agent to rebuild its system prompt from current memory state. */
export function refreshPrompt(
  signal?: AbortSignal
): Promise<{ ok: boolean; refreshedAt?: string }> {
  return requestJson<{ ok: boolean; refreshedAt?: string }>(
    `${BASE}/refresh-prompt`,
    { method: "POST", signal }
  );
}

/** Full-text search across blocks and messages. */
export function searchMemory(
  query: string,
  signal?: AbortSignal
): Promise<GetMemoryResponse> {
  const url = `${BASE}/search?q=${encodeURIComponent(query)}`;
  return requestJson<GetMemoryResponse>(url, { signal });
}

/** Permanently delete specific messages by ID. */
export function deleteMessages(
  ids: string[],
  signal?: AbortSignal
): Promise<GetMemoryResponse> {
  return requestJson<GetMemoryResponse>(`${BASE}/delete-messages`, {
    method: "POST",
    body: JSON.stringify({ ids }),
    signal,
  });
}

/** Clear the entire session message history. */
export function clearHistory(
  signal?: AbortSignal
): Promise<GetMemoryResponse> {
  return requestJson<GetMemoryResponse>(`${BASE}/clear-history`, {
    method: "POST",
    signal,
  });
}
