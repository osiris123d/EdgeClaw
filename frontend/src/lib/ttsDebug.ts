/**
 * Whether to print `[EdgeClaw][tts-debug]` lines in the browser console.
 * Production `vite build` sets `import.meta.env.DEV === false`, so we do not gate
 * tts-debug on that flag alone. Suppress in production (only) with:
 *   localStorage.setItem("edgeclawTtsDebug", "0");
 */
export function isEdgeclawTtsDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    if (localStorage.getItem("edgeclawTtsDebug") === "0") return false;
  } catch {
    /* private mode, etc. */
  }
  return true;
}
