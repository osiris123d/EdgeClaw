/**
 * BrowserSessionRepository
 *
 * Durably persists BrowserSessionState inside the agent's Durable Object storage.
 * Each session is stored under a predictable key so it survives reconnects and
 * worker restarts.
 */

import type { BrowserSessionState, BrowserSessionStatus } from "./types";

const SESSION_KEY_PREFIX = "browser-session:";

export class BrowserSessionRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  private key(sessionId: string): string {
    return `${SESSION_KEY_PREFIX}${sessionId}`;
  }

  async get(sessionId: string): Promise<BrowserSessionState | undefined> {
    return this.storage.get<BrowserSessionState>(this.key(sessionId));
  }

  async save(session: BrowserSessionState): Promise<void> {
    session.updatedAt = Date.now();
    await this.storage.put(this.key(session.sessionId), session);
  }

  async patch(
    sessionId: string,
    updates: Partial<Omit<BrowserSessionState, "sessionId" | "createdAt">>
  ): Promise<BrowserSessionState | undefined> {
    const existing = await this.get(sessionId);
    if (!existing) return undefined;
    const updated: BrowserSessionState = { ...existing, ...updates, updatedAt: Date.now() };
    await this.storage.put(this.key(sessionId), updated);
    return updated;
  }

  async transition(
    sessionId: string,
    newStatus: BrowserSessionStatus
  ): Promise<BrowserSessionState | undefined> {
    return this.patch(sessionId, { status: newStatus });
  }

  async delete(sessionId: string): Promise<void> {
    await this.storage.delete(this.key(sessionId));
  }

  /**
   * List all active sessions (status = pending | launching | active | awaiting_human | disconnected).
   * Bounded scan — returns at most 50 entries to avoid large storage reads.
   */
  async listActive(): Promise<BrowserSessionState[]> {
    const all = await this.storage.list<BrowserSessionState>({
      prefix: SESSION_KEY_PREFIX,
      limit: 50,
    });
    const active: BrowserSessionState[] = [];
    for (const session of all.values()) {
      if (
        session.status !== "completed" &&
        session.status !== "abandoned"
      ) {
        active.push(session);
      }
    }
    return active;
  }
}
