import type { ContextEventItem } from "../types";

/**
 * Derives the set of skill keys that are currently loaded into the agent's
 * context window, given an ordered list of context activity events from the
 * chat timeline.
 *
 * Rules:
 *  - "load" / "create"  → key enters the loaded set
 *  - "unload" / "delete" → key leaves the loaded set
 *  - "update"            → no change (skill stays loaded if it was)
 *
 * Only events that carry a `skillKey` (the raw storage key, e.g.
 * "code-reviewer") contribute to the set.  Events where the key could not
 * be recovered from the tool arguments are ignored — they cannot be correlated
 * with a SkillSummary.key and should not produce false positives.
 *
 * ---
 * Wiring guide (when you're ready to connect this to live session state):
 *
 *   1. Lift `timeline` state from ChatPage to App.tsx (or use a shared context).
 *   2. Filter to context events:
 *        const ctxEvents = timeline.filter(
 *          (item): item is ContextEventItem => item.kind === "context-event"
 *        );
 *   3. Pass ctxEvents to SkillsPage via the `loadedKeys` prop:
 *        <SkillsPage loadedKeys={deriveLoadedSkillKeys(ctxEvents)} />
 *
 * Until that wiring exists, pass an empty Set (the default) and the indicator
 * simply stays hidden — no false positives.
 */
export function deriveLoadedSkillKeys(events: ContextEventItem[]): ReadonlySet<string> {
  const loaded = new Set<string>();

  for (const event of events) {
    const key = event.skillKey;
    if (!key) continue;

    switch (event.action) {
      case "load":
      case "create":
        loaded.add(key);
        break;
      case "unload":
      case "delete":
        loaded.delete(key);
        break;
      case "update":
        // Update does not change whether the skill is loaded.
        break;
    }
  }

  return loaded;
}
