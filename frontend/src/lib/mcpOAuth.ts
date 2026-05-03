/**
 * OAuth popup manager for MCP server authorization.
 *
 * End-to-end flow:
 *   1. Frontend calls openOAuthPopup(authUrl, onComplete).
 *   2. A popup window opens at authUrl (the OAuth provider's authorization page).
 *   3. After the user authorizes, the provider redirects to the agent's callback URL
 *      (e.g. /agents/main-agent/default/callback).
 *   4. The agent's configureOAuthCallback handler returns an HTML page that:
 *        a. Posts { type: "mcp-oauth-complete", success: true|false } to window.opener.
 *        b. Calls window.close() after a short delay.
 *   5. The message event listener fires, calls onComplete({ success, reason:"message" }),
 *      and the caller schedules a post-OAuth refresh sequence.
 *   6. If the user closes the popup manually before auth completes, the closed-popup
 *      poller fires onComplete({ success: false, reason: "closed" }).
 *   7. If the popup is blocked by the browser, onComplete fires synchronously with
 *      reason "blocked".
 *   8. A 10-minute timeout fires if neither message nor close is detected.
 *
 * Event ordering guarantee:
 *   - onComplete is called EXACTLY ONCE, the first time any terminal event fires.
 *   - Once the success postMessage is received, any later "closed" or "cancelled"
 *     events are suppressed with a [MCP-DIAG] log entry.
 *   - The abort function (returned to caller) is a no-op if success was already received.
 *
 * Tokens and auth state are NEVER returned to the frontend.
 * The SDK stores OAuth tokens in DO SQLite automatically.
 */

export interface OAuthPopupResult {
  /** true if the agent's callback page confirmed successful token exchange. */
  success: boolean;
  /**
   * "message"   — agent callback page posted the mcp-oauth-complete message.
   * "blocked"   — popup window.open() was blocked by the browser.
   * "closed"    — user closed the popup before auth completed.
   * "timeout"   — popup was open for longer than timeoutMs with no completion.
   * "cancelled" — caller invoked the returned abort function before auth completed.
   */
  reason: "message" | "blocked" | "closed" | "timeout" | "cancelled";
}

export interface OAuthPopupOptions {
  /**
   * Milliseconds before the flow is treated as timed-out.
   * Default: 600_000 (10 minutes) — long enough for SSO flows.
   */
  timeoutMs?: number;
  /**
   * How often in ms to check whether the popup was manually closed.
   * Default: 1_000.
   */
  pollIntervalMs?: number;
  /** Pixel dimensions of the popup window. Defaults to 600 × 700. */
  width?: number;
  height?: number;
}

/** Call this to cancel the pending popup and abort the OAuth flow. */
export type OAuthPopupAbort = () => void;

/**
 * Open an OAuth authorization popup and asynchronously report the result.
 *
 * @param authUrl    The authorization URL from the MCP server (via addMcpServer result).
 * @param onComplete Called exactly once when the flow resolves (success or failure).
 * @returns          An abort function — call it to cancel the flow and close the popup.
 *
 * @example
 * const abort = openOAuthPopup(server.auth.authUrl, (result) => {
 *   if (result.reason === "message" && result.success) {
 *     // schedule post-OAuth refreshes
 *   } else if (result.reason === "blocked") {
 *     setError("Popup was blocked — please allow popups for this site.");
 *   }
 * });
 *
 * // On component unmount:
 * useEffect(() => () => abort(), []);
 */
export function openOAuthPopup(
  authUrl: string,
  onComplete: (result: OAuthPopupResult) => void,
  options: OAuthPopupOptions = {}
): OAuthPopupAbort {
  const { timeoutMs = 600_000, pollIntervalMs = 1_000, width = 600, height = 700 } = options;

  // Center the popup on the current screen.
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top  = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  const features = `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`;

  // noopener intentionally omitted: we need window.opener in the callback page
  // to post a message back. The callback URL is on the same origin as this app,
  // so the opener reference is not a security risk.
  const popup = window.open(authUrl, "mcp-oauth-popup", features);

  if (!popup || popup.closed) {
    console.log("[MCP-DIAG] popup blocked — window.open() returned null");
    onComplete({ success: false, reason: "blocked" });
    return () => {};
  }

  // successReceived tracks whether the mcp-oauth-complete postMessage arrived with
  // success=true.  It is set BEFORE `settled` so that the close-poll and abort
  // function can log the correct reason without firing onComplete a second time.
  let successReceived = false;
  let settled = false;

  const finish = (result: OAuthPopupResult) => {
    if (settled) {
      // Suppress any late event that arrives after the flow already resolved.
      if (result.reason === "closed" || result.reason === "cancelled") {
        console.log(
          `[MCP-DIAG] popup ${result.reason} event suppressed — ` +
          (successReceived
            ? "OAuth success was already received"
            : "flow was already settled")
        );
      }
      return;
    }
    settled = true;
    window.removeEventListener("message", onMessage);
    clearInterval(pollId);
    clearTimeout(timeoutId);
    onComplete(result);
  };

  // Listen for the agent's callback page posting { type: "mcp-oauth-complete" }.
  const onMessage = (e: MessageEvent) => {
    // Verify the message comes from the popup or the same origin.
    // Cross-document source references can be null in some browsers so we
    // accept same-origin messages even when source check fails.
    if (e.source !== popup && e.origin !== window.location.origin) return;
    if (typeof e.data !== "object" || e.data === null) return;
    if (e.data.type !== "mcp-oauth-complete") return;

    const success = e.data.success !== false; // treat absent field as success
    if (success) successReceived = true;
    console.log(`[MCP-DIAG] popup postMessage received — success=${success}`);
    finish({ success, reason: "message" });
  };

  window.addEventListener("message", onMessage);

  // Poll for manual popup closure (user hit ✕ without completing auth).
  const pollId = setInterval(() => {
    try {
      if (!popup.closed) return;

      if (successReceived) {
        // Popup closed after OAuth completed — the success result was already
        // delivered via finish().  This close is the popup's natural window.close()
        // call after a brief display delay.  Suppress it.
        console.log(
          "[MCP-DIAG] popup closed after OAuth success — suppressed (success already delivered)"
        );
        clearInterval(pollId);
        return;
      }

      // Popup closed before auth completed — user dismissed it.
      console.log("[MCP-DIAG] popup closed by user before auth completed");
      finish({ success: false, reason: "closed" });
    } catch {
      // Cross-origin access to popup.closed can throw in some browsers.
      // If we can't check, do nothing — timeout will eventually fire.
    }
  }, pollIntervalMs);

  // Hard timeout — close the popup and report failure.
  const timeoutId = setTimeout(() => {
    try { popup.close(); } catch { /* ignore */ }
    console.log("[MCP-DIAG] popup timed out after " + timeoutMs + "ms");
    finish({ success: false, reason: "timeout" });
  }, timeoutMs);

  // Abort function returned to the caller.
  return () => {
    try { popup.close(); } catch { /* ignore */ }
    if (successReceived) {
      // OAuth was already completed successfully.  This abort is from component
      // cleanup or a new popup being opened.  Do not override the success result.
      console.log("[MCP-DIAG] popup abort called after OAuth success — no-op");
      return;
    }
    console.log("[MCP-DIAG] popup aborted by caller");
    finish({ success: false, reason: "cancelled" });
  };
}
