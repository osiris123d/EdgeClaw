/**
 * VoiceControls.tsx
 *
 * Compact voice toolbar rendered as part of the chat composer
 * (.composer.has-voice keeps the existing grid; this component spans
 * both columns via grid-column in styles.css).
 *
 * Provides:
 *   - start / end call
 *   - mute toggle
 *   - agent-speaks toggle
 *   - status pill with animated dot
 *   - inline audio level meter (width driven by inline style, not keyframes)
 *   - interim transcript preview (ephemeral STT partial — never committed to
 *     the conversation timeline; see ChatPage.tsx for the reconciliation logic)
 *
 * Accessibility:
 *   - All buttons have explicit aria-label + aria-pressed.
 *   - Status changes are announced via a hidden aria-live="polite" region.
 *   - Interim transcript deliberately uses aria-live="off" — rapidly-changing
 *     partial text would produce an unusable screen reader experience.
 *
 * Styling:
 *   - No external UI library; class names match styles.css voice-toolbar block.
 *   - CSS variables (--primary, --muted, --border, etc.) provide theme tokens.
 */

import type { VoiceStatus } from "@cloudflare/voice/react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VoiceControlsProps {
  /** Master feature flag — renders null when false. */
  enabled: boolean;
  /** Current voice pipeline phase from the Cloudflare Voice SDK. */
  status: VoiceStatus;
  /** Whether the WebSocket to the voice agent is currently open. */
  connected: boolean;
  /** Whether the mic is muted (call alive, audio not sent). */
  isMuted: boolean;
  /** Instantaneous mic RMS in [0, 1] — drives the level meter width. */
  audioLevel: number;
  /** Real-time partial transcript while the user speaks; null when silent. */
  interimTranscript: string | null;
  /** Whether TTS playback is enabled for agent responses. */
  agentShouldSpeak: boolean;
  /**
   * Human-readable error from the voice layer (mic denial, connection failure,
   * etc.).  When set, an inline error message is rendered within the toolbar so
   * the composer area remains usable and the feed is not interrupted.
   * Pass voice.error from useEdgeClawVoice directly.
   */
  error?: string | null;
  /** Open mic and start the call. */
  onStart: () => void | Promise<void>;
  /** End the call and release the mic. */
  onStop: () => void;
  /** Toggle mic mute without ending the call. */
  onToggleMute: () => void;
  /** Toggle TTS playback for agent responses. */
  onToggleAgentShouldSpeak: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<VoiceStatus, string> = {
  idle:      "Ready",
  listening: "Listening",
  thinking:  "Thinking",
  speaking:  "Speaking",
};

/** Full-sentence descriptions for the sr-only live region. */
const STATUS_DESCRIPTIONS: Record<VoiceStatus, string> = {
  idle:      "Voice is ready. Press Call to begin.",
  listening: "Listening — speak now.",
  thinking:  "Agent is processing your message.",
  speaking:  "Agent is speaking.",
};

// ── Component ──────────────────────────────────────────────────────────────────

export function VoiceControls({
  enabled,
  status,
  connected,
  isMuted,
  audioLevel,
  interimTranscript,
  agentShouldSpeak,
  error = null,
  onStart,
  onStop,
  onToggleMute,
  onToggleAgentShouldSpeak,
}: VoiceControlsProps) {
  if (!enabled) return null;

  const isLive      = status !== "idle";
  const isListening = status === "listening";
  const isSpeaking  = status === "speaking";

  const statusLabel       = STATUS_LABELS[status];
  const statusDescription = STATUS_DESCRIPTIONS[status];

  // Level meter: show only when mic is open and capturing.
  // During thinking/speaking the server owns the audio path, so a live mic
  // meter would be misleading.
  const showLevelMeter = isListening && !isMuted;
  const levelPercent   = Math.round(audioLevel * 100);

  return (
    <div
      className={`voice-toolbar${isLive ? " is-live" : ""}`}
      role="group"
      aria-label="Voice controls"
    >
      {/* ── Top row: status pill + level meter ──────────────────────────── */}
      <div className="voice-toolbar-main">

        {/* Status pill */}
        <span
          className={`voice-status-pill voice-status-${status}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          title={statusDescription}
        >
          <span
            className={`voice-status-dot${isLive ? " is-active" : ""}`}
            aria-hidden="true"
          />
          <span>{statusLabel}</span>
        </span>

        {/* Mic level meter — width controlled by inline style (not keyframes) */}
        {showLevelMeter && (
          <span
            className="voice-level-meter"
            aria-hidden="true"
            title={`Mic level ${levelPercent}%`}
          >
            <span
              className="voice-level-bar"
              style={{ width: `${levelPercent}%` }}
            />
          </span>
        )}

        {/* "Playing" badge — visible while agent TTS is active */}
        {isSpeaking && (
          <span className="voice-speaking-badge" aria-hidden="true">
            Playing
          </span>
        )}
      </div>

      {/* ── Action buttons ───────────────────────────────────────────────── */}
      <div className="voice-toolbar-actions">

        {/* Start / End call — rendered as two distinct class variants so CSS
            can style them independently without an .is-active hack. */}
        {isLive ? (
          <button
            type="button"
            className="voice-end-btn"
            aria-label="End voice call"
            aria-pressed={true}
            onClick={onStop}
          >
            <span className="voice-btn-icon" aria-hidden="true" />
            <span>End</span>
          </button>
        ) : (
          <button
            type="button"
            className="voice-mic-btn"
            aria-label="Start voice call"
            aria-pressed={false}
            // Disable while the WebSocket is not yet open to avoid a silent
            // failure — the SDK can't start without a live connection.
            disabled={!connected}
            onClick={onStart}
          >
            <span className="voice-btn-icon" aria-hidden="true" />
            <span>Call</span>
          </button>
        )}

        {/* Mute / Unmute — only during a live call; hidden at idle to keep
            the toolbar minimal when no call is in progress. */}
        {isLive && (
          <button
            type="button"
            className={`voice-toggle${isMuted ? " is-muted" : ""}`}
            aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={isMuted}
            onClick={onToggleMute}
          >
            <span className="voice-btn-icon" aria-hidden="true" />
            <span>{isMuted ? "Unmute" : "Mute"}</span>
          </button>
        )}

        {/* Agent-speaks toggle — controls whether the agent's replies are
            spoken aloud via TTS.  Available before and during a call so the
            user can opt out before starting. */}
        <button
          type="button"
          className={`voice-toggle${agentShouldSpeak ? " is-on" : ""}`}
          aria-label={
            agentShouldSpeak
              ? "Agent voice on — click to silence agent"
              : "Agent voice off — click to enable agent voice"
          }
          aria-pressed={agentShouldSpeak}
          onClick={onToggleAgentShouldSpeak}
        >
          <span className="voice-btn-icon" aria-hidden="true" />
          <span>Agent</span>
        </button>
      </div>

      {/* ── Interim transcript preview ───────────────────────────────────── */}
      {/*
        Ephemeral partial STT output — shown for live feedback only.

        Why aria-live="off":
          The interim transcript is rewritten many times per second while the
          user speaks.  If we set aria-live="polite" or "assertive", a screen
          reader would interrupt itself repeatedly with half-formed words,
          creating an unusable experience.  The finalized utterance is announced
          via the chat timeline once the STT model emits the final entry.

        This element MUST NOT be committed to the conversation timeline.  Only
        voice.transcript final entries are routed to the agent (see ChatPage.tsx).
      */}
      {interimTranscript && (
        <div
          className="voice-transcript-preview"
          aria-live="off"
          aria-label="Partial transcript — still listening"
        >
          <span className="voice-transcript-cursor" aria-hidden="true" />
          <span className="voice-transcript-text">{interimTranscript}</span>
        </div>
      )}

      {/* ── Dedicated screen-reader live region ─────────────────────────── */}
      {/*
        Separate from the visual status pill so the announcement is phrased in
        full prose ("Listening — speak now.") rather than the terse pill label
        ("Listening").  This also avoids polluting the visual layout with
        verbose text.
      */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusDescription}
        {isMuted ? " Microphone is muted." : ""}
      </div>

      {/* ── Inline voice error ───────────────────────────────────────────── */}
      {/*
        Rendered within the toolbar (near the composer) rather than as a
        page-level banner, so the chat feed and text composer are never
        disrupted.  The user can still type and send messages even if voice
        fails.

        aria-live="assertive" is correct here: mic failures demand immediate
        attention and this element changes infrequently (only on call start
        failure), so it won't create the repetitive interruption that makes
        assertive regions normally undesirable.
      */}
      {error && (
        <div
          className="voice-error-inline"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <span className="voice-error-icon" aria-hidden="true" />
          <span className="voice-error-text">{error}</span>
        </div>
      )}
    </div>
  );
}
