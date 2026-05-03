/**
 * VoiceMicButton.tsx
 *
 * Compact voice control widget to the right of Send: mic (inline SVG) +
 * vertical bar meter + agent-speaks toggle in one chip. Unmuted = dark field +
 * teal border/meter; muted = dark wine + red (CSS color transition on toggle).
 *
 * Visual state comes from `voiceUiState` (see `getVoiceUiState` in VoiceService):
 * **Muted** is a user-trust state — dots stay static (no local RMS), even if the
 * browser still captures audio. **Ready** is connected + unmuted + not actively
 * hearing speech; **Listening** only when speech is in progress.
 *
 * This component does NOT manage any state.  All state is owned by ChatPage
 * via useEdgeClawVoice.  Click handlers are passed in as props.
 *
 * Accessibility:
 *   - Mic toggle button has aria-label + aria-pressed
 *   - Agent-speaks toggle has aria-label + aria-pressed
 *   - Bar meter is aria-hidden (decorative)
 *   - Status changes announced via sr-only live region
 */

import type { VoiceUiStateOrOff } from "../../voice/VoiceService";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VoiceMicButtonProps {
  /** Unified UI phase from ChatPage (`getVoiceUiState`). */
  voiceUiState: VoiceUiStateOrOff;
  /**
   * 0-1 level for the dot row, typically `voice.displayMeterLevel`.
   * Only applied when `voiceUiState === "listening"`; ignored when muted/ready
   * so local measurement never animates the meter in trust-sensitive states.
   */
  audioLevel: number;
  /** Whether TTS playback should be active for agent responses. */
  agentShouldSpeak: boolean;
  /** Human-readable error, or null. Rendered inline when set. */
  error?: string | null;
  /** Toggle mic mute. If the call is not yet started, start it first (ChatPage handles this). */
  onToggleMute: () => void;
  /** Toggle agent TTS on/off. */
  onToggleAgentSpeaks: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const NUM_BARS = 7;
/** Min / max bar height (px) for the in-widget level meter. */
const BAR_H = { min: 3, max: 16 } as const;

/** Aria labels for the mic button per UI state. */
const MIC_ARIA: Record<VoiceUiStateOrOff, string> = {
  off:       "Microphone (not connected)",
  muted:     "Unmute microphone — start speaking",
  ready:     "Mute microphone — waiting for speech",
  listening: "Mute microphone",
  thinking:  "Mute microphone — agent is processing",
  speaking:  "Mute microphone — interrupt agent",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * CSS modifier for the widget root. Unmuted live states use the same teal
 * "live" skin; `muted` switches to the red theme (color transitions in CSS).
 */
function widgetModifierClass(ui: VoiceUiStateOrOff): string {
  if (ui === "ready") {
    return "voice-mic-widget voice-mic-widget--ready";
  }
  return `voice-mic-widget voice-mic-widget--${ui}`;
}

/**
 * Vertical bar heights: only **listening** follows `audioLevel`. Muted/ready
 * use a calm static pattern (user-trust); thinking/speaking get a small idle wave.
 */
function barHeight(
  i: number,
  audioLevel: number,
  voiceUiState: VoiceUiStateOrOff
): number {
  const { min, max } = BAR_H;
  if (voiceUiState === "off") {
    return min;
  }
  if (voiceUiState === "muted") {
    // Static, equal “idle” slivers in red (no fake RMS in muted).
    return min + 1;
  }
  if (voiceUiState === "listening") {
    const threshold = (i + 1) / NUM_BARS;
    const on = audioLevel >= threshold;
    if (!on) {
      return min;
    }
    // Left bars react first; a gentle slope when active.
    const w = 1 - i / (NUM_BARS + 1);
    return min + w * (max - min) * 0.85;
  }
  if (voiceUiState === "ready") {
    const wobble = [4, 5, 4, 5, 4, 4, 3][i] ?? min;
    return wobble;
  }
  // thinking / speaking — small wave baseline; pulsing is CSS
  return min + 3 + (i % 3) * 0.5 + (i * 0.4);
}

function barPulseClass(voiceUiState: VoiceUiStateOrOff): string {
  return voiceUiState === "speaking" || voiceUiState === "thinking" ? " is-pulsing" : "";
}

function MicGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 10v2a4 4 0 0 0 8 0v-2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 18v2" stroke="currentColor" strokeWidth="1.5" />
      {muted && (
        <path
          d="M4 4L20 20"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function VoiceMicButton({
  voiceUiState,
  audioLevel,
  agentShouldSpeak,
  error = null,
  onToggleMute,
  onToggleAgentSpeaks,
}: VoiceMicButtonProps) {
  const micDisabled = voiceUiState === "off";
  const micLabel = MIC_ARIA[voiceUiState] ?? "Microphone";
  /** Mic is "live" for a11y when connected and not in the silenced trust state. */
  const isMicEngaged = voiceUiState !== "off" && voiceUiState !== "muted";

  return (
    <div
      className={widgetModifierClass(voiceUiState)}
      role="group"
      aria-label="Voice controls"
    >
      {/* ── Mic toggle button ─────────────────────────────────────────────── */}
      <button
        type="button"
        className="voice-mic-main-btn"
        aria-label={micLabel}
        aria-pressed={isMicEngaged}
        disabled={micDisabled}
        onClick={onToggleMute}
      >
        <span
          className={`voice-mic-icon${voiceUiState === "muted" ? " voice-mic-icon--muted" : ""}`}
          aria-hidden="true"
        >
          <MicGlyph muted={voiceUiState === "muted"} />
        </span>
      </button>

      {/* Decorative level meter: vertical bars; only `listening` follows RMS. */}
      <div className="voice-mic-bars" aria-hidden="true">
        {Array.from({ length: NUM_BARS }, (_, i) => (
          <span
            key={i}
            className={`voice-mic-bar${barPulseClass(voiceUiState)}`}
            style={{ height: `${barHeight(i, audioLevel, voiceUiState)}px` }}
          />
        ))}
      </div>

      {/* ── Agent-speaks toggle ───────────────────────────────────────────── */}
      {/*
        Small icon button that controls whether the agent's text replies are
        also played back as TTS audio.  Independent of the mic mute state
        so the user can listen to the agent without using their own mic.
      */}
      <button
        type="button"
        className={`voice-speak-toggle${agentShouldSpeak ? " is-on" : ""}`}
        aria-label={
          agentShouldSpeak
            ? "Agent voice on — click to silence"
            : "Agent voice off — click to enable"
        }
        aria-pressed={agentShouldSpeak}
        onClick={onToggleAgentSpeaks}
        title={agentShouldSpeak ? "Agent speaks: on" : "Agent speaks: off"}
      >
        <span className="voice-speak-icon" aria-hidden="true" />
      </button>

      {/* ── sr-only live status announcement ─────────────────────────────── */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {voiceUiState === "off"       && "Voice not connected."}
        {voiceUiState === "muted"     && "Microphone muted."}
        {voiceUiState === "ready"     && "Microphone on, ready."}
        {voiceUiState === "listening" && "Listening."}
        {voiceUiState === "thinking"  && "Agent thinking."}
        {voiceUiState === "speaking"  && "Agent speaking."}
      </div>

      {/* ── Inline error ─────────────────────────────────────────────────── */}
      {error && (
        <div
          className="voice-mic-error"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {error}
        </div>
      )}
    </div>
  );
}
