/**
 * VoiceService.ts
 *
 * Adapter hook that wraps @cloudflare/voice/react's `useVoiceAgent` and exposes
 * a normalized, memoized interface for the EdgeClaw chat UI.
 *
 * ── Cloudflare voice lifecycle (withVoice) ────────────────────────────────────
 *
 *   idle       → WebSocket connected, audio pipeline not started
 *   listening  → startCall() called; mic open; STT model detecting speech turns
 *   thinking   → utterance finished; onTurn() running server-side
 *   speaking   → TTS audio streaming back; client playing response
 *
 * Browser ─── binary PCM (16 kHz) ──► Durable Object (withVoice mixin)
 *          ◄── JSON: transcript ────── STT → onTurn() → sentence chunker
 *          ◄── binary: TTS audio ───── TTS provider
 *
 * This file is pure adapter logic — no JSX, no app-specific rendering.
 * It is the single source of truth for voice state shape used by the UI layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useVoiceAgent,
  type TranscriptMessage,
  type VoiceStatus,
} from "@cloudflare/voice/react";
// TEMP: [voice-dbg-client] — remove with voiceDebugTransport.ts
import { createDebugWrappingTransport, VOICE_CLIENT_DBG } from "./voiceDebugTransport";

const VOICE_DBG = "[voice-dbg-client]";

// ── Shared voice **UI** model (badge + mic chrome) ────────────────────────────
//
// Distinct from raw SDK `VoiceStatus`: users care whether the app *acts* like
// it is listening, not only whether a WebSocket says "listening".

/** Toolbar / header states when the voice feature is in use. */
export type VoiceUiState = "muted" | "ready" | "listening" | "thinking" | "speaking";

/** WebSocket not open — badge shows "off"; mic widget is dimmed/disabled. */
export type VoiceUiStateOrOff = VoiceUiState | "off";

/**
 * Single mapping from transport + UX inputs to one visual voice state.
 *
 * **Muted first for trust:** when `isMuted`, we never surface the "Listening"
 * chrome even if the SDK is still `listening` or local RMS is non-zero.
 * Agent `thinking` / `speaking` stay first so muted users still see TTS/progress.
 *
 * **Ready vs listening:** both require an unmuted mic; `listening` only when
 * `hasActiveSpeech` (e.g. interim STT text) so "waiting for speech" stays Ready.
 */
export function getVoiceUiState(args: {
  connected: boolean;
  isMuted: boolean;
  status: VoiceStatus;
  hasActiveSpeech: boolean;
}): VoiceUiStateOrOff {
  const { connected, isMuted, status, hasActiveSpeech } = args;
  if (!connected) return "off";
  if (status === "thinking") return "thinking";
  if (status === "speaking") return "speaking";
  if (isMuted) return "muted";
  if (status === "idle") return "ready";
  return hasActiveSpeech ? "listening" : "ready";
}

// ── Public types ──────────────────────────────────────────────────────────────

/** Parameters accepted by useEdgeClawVoice. */
export interface EdgeClawVoiceParams {
  /**
   * Agent class name — must match the Durable Object class registered on the
   * server (the class decorated with `withVoice`).
   */
  agent: string;

  /**
   * Durable Object instance name. Identifies which "room" / session the user
   * joins. Use "default" for a single shared session.
   * @default "default"
   */
  name?: string;

  /**
   * Hostname for the WebSocket connection.
   * @default window.location.host
   */
  host?: string;

  /**
   * Feature flag. When false every action is a no-op and the returned state is
   * a stable idle baseline — no microphone access or WebSocket is opened.
   * @default true
   */
  enabled?: boolean;
}

/** Normalized voice state and actions exposed to the chat UI. */
export interface EdgeClawVoiceState {
  /**
   * Current pipeline phase.
   *   "idle"      — call not started; no mic access
   *   "listening" — mic streaming; waiting for user utterance
   *   "thinking"  — STT complete; onTurn() executing server-side
   *   "speaking"  — TTS streaming back; agent is talking
   */
  status: VoiceStatus;

  /** True while the WebSocket to the agent DO is open. */
  connected: boolean;

  /** True when the mic is muted (frames not sent, call still alive). */
  isMuted: boolean;

  /**
   * Instantaneous microphone RMS from the SDK (unscaled; often 0.01-0.15 in speech).
   * Prefer `displayMeterLevel` for UI meters.
   */
  audioLevel: number;

  /**
   * 0-1, scaled for a visible VU-style meter. Maps raw RMS (often small) into a
   * range the dot row in VoiceMicButton can use with meaningful motion.
   *
   * Note: the browser/SDK may still measure local mic input while `isMuted` is
   * true (upstream frames are not sent). For UX that should not look like
   * "actively listening", treat `displayMeterLevel` as inactive when muted and
   * keep the meter flat (see VoiceMicButton).
   */
  displayMeterLevel: number;

  /**
   * Full conversation history delivered by the server.
   * Each entry: `{ role: "user" | "assistant", text: string }`.
   * Grows throughout the call; stable array reference between renders when
   * nothing has changed.
   */
  transcript: TranscriptMessage[];

  /**
   * Real-time partial transcript while the user is speaking.
   * Null when the user is silent, the call is idle, or the call has just ended.
   * Guaranteed to be null when status === "idle" so stale values never leak
   * into the UI after a call terminates.
   */
  interimTranscript: string | null;

  /**
   * Human-readable error string, or null.
   * Combines the SDK's own error field with errors captured during startVoice
   * (e.g. microphone permission denial) so callers see a single error channel.
   * Mapped to short, actionable copy via formatVoiceError.
   */
  error: string | null;

  /**
   * Start a voice call: request microphone permission and begin streaming audio
   * to the agent's STT pipeline.
   *
   * Errors (mic denied, device not found, etc.) are caught internally and
   * surfaced via the `error` field — this function never rejects so it is safe
   * to use directly as a button onClick handler.
   *
   * Maps to VoiceClient.startCall() / useVoiceAgent().startCall.
   */
  startVoice: () => Promise<void>;

  /**
   * End the voice call and release the microphone.
   * The WebSocket stays open so a new call can be started without reconnecting.
   * Also clears any local error set by a previous failed startVoice.
   *
   * Maps to VoiceClient.endCall() / useVoiceAgent().endCall.
   */
  stopVoice: () => void;

  /**
   * Toggle microphone mute. The mic stays active (no permission re-prompt) but
   * audio frames are not forwarded to the server while muted.
   *
   * Maps to useVoiceAgent().toggleMute.
   */
  toggleMute: () => void;

  /**
   * Deterministically set the mute state to the requested value.
   *
   * Unlike `toggleMute` (which blindly flips the current state), this:
   *   1) ignores duplicate requests for the same `wantMuted` before the SDK
   *      has re-rendered (tracks an in-flight *intended* mute state in a ref)
   *   2) only calls the SDK `toggle` when the reflected `isMuted` read still
   *      disagrees with the intended value, after the SDK re-syncs
   *
   * Prefer this over `toggleMute` any time you need a known mute outcome
   * (e.g. start session muted, normalize after reconnect).
   */
  setMuted: (wantMuted: boolean) => void;

  /**
   * Inject text into the voice pipeline without using the microphone.
   * The text is forwarded directly to the agent's onTurn() method, bypassing
   * STT. The agent's TTS response streams back normally.
   *
   * Maps to VoiceClient.sendText() / useVoiceAgent().sendText.
   */
  sendVoiceText: (text: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Stable empty array reused across renders when voice is disabled or the
 * transcript is empty.  Avoids spurious reference-inequality re-renders.
 */
const EMPTY_TRANSCRIPT: TranscriptMessage[] = [];

// ── Error mapper ──────────────────────────────────────────────────────────────

/**
 * formatVoiceError
 *
 * Maps a raw thrown value (DOMException, Error, SDK string, or unknown) to a
 * short, actionable, human-readable message suitable for inline UI display.
 *
 * Handles the most common real-browser failure modes:
 *   - Mic permission denied (NotAllowedError)
 *   - No mic device found (NotFoundError)
 *   - Mic already claimed by another app (NotReadableError)
 *   - Browser security policy blocking mic (SecurityError)
 *   - Aborted getUserMedia call (AbortError)
 *   - Network / WebSocket failures
 *   - Generic catch-all
 *
 * This is exported so it can be used by callers that catch voice errors
 * independently (e.g. in tests or a future error boundary).
 */
export function formatVoiceError(err: unknown): string {
  // ── DOMException — the most common source for mic errors ─────────────────
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Microphone access was denied. Allow it in your browser's site settings and try again.";

      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone found. Connect a microphone and try again.";

      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is in use by another application. Close it and try again.";

      case "SecurityError":
        return "Microphone access is blocked by your browser's security policy.";

      case "AbortError":
        return "Microphone access was interrupted. Please try again.";

      default:
        // DOMException but unrecognised — fall through to generic
        break;
    }
  }

  // ── Generic Error — may come from the WebSocket layer ────────────────────
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    if (msg.includes("permission") || msg.includes("denied") || msg.includes("not allowed")) {
      return "Microphone access was denied. Check your browser settings and try again.";
    }
    if (msg.includes("not found") || msg.includes("device")) {
      return "No microphone found. Connect a microphone and try again.";
    }
    if (msg.includes("network") || msg.includes("websocket") || msg.includes("connect")) {
      return "Connection to the voice server failed. Check your network and try again.";
    }
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return "Voice call timed out. Please try again.";
    }
    if (msg.includes("in use") || msg.includes("busy")) {
      return "Microphone is in use by another application. Close it and try again.";
    }
  }

  // ── Plain string — the Cloudflare SDK may surface these ──────────────────
  if (typeof err === "string") {
    const lower = err.toLowerCase();
    if (lower.includes("permission") || lower.includes("denied") || lower.includes("not allowed")) {
      return "Microphone access was denied. Check your browser settings and try again.";
    }
    if (lower.includes("not found") || lower.includes("device")) {
      return "No microphone found. Connect a microphone and try again.";
    }
    if (lower.includes("network") || lower.includes("websocket") || lower.includes("connect")) {
      return "Connection to the voice server failed. Check your network and try again.";
    }
  }

  // ── Catch-all ─────────────────────────────────────────────────────────────
  return "Voice is unavailable right now. Check your microphone and connection, then try again.";
}

/**
 * Raw RMS from the voice SDK is often 0.01-0.15 in normal conversation; a
 * naive bar that lights only when rms is above each step (e.g. 1/7) looks
 * broken. Map to [0, 1]
 * with extra gain in the low end (sqrt curve + linear) so the UI matches what
 * the user hears in the system mic level control.
 */
export function mapVoiceRmsToDisplayMeter(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, Math.sqrt(rms) * 2.6 + rms * 1.8);
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useEdgeClawVoice
 *
 * Normalized voice adapter hook for the EdgeClaw chat UI.
 *
 * Always calls useVoiceAgent to satisfy React's Rules of Hooks.  When
 * `enabled` is false the callbacks become no-ops and the state is a stable
 * idle baseline — callers never need to branch on the enabled flag.
 *
 * Error handling:
 *   startVoice catches all thrown values (DOMException from getUserMedia, SDK
 *   errors, network failures) and stores them locally.  It never rejects to the
 *   caller, so it is safe to pass directly to button onClick handlers.  Errors
 *   are surfaced through the `error` field and cleared the next time stopVoice
 *   is called or a new call succeeds.
 *
 * @example
 * ```tsx
 * const voice = useEdgeClawVoice({ agent: "MainAgent", enabled: voiceEnabled });
 *
 * // Show a waveform when listening
 * <Waveform level={voice.audioLevel} active={voice.status === "listening"} />
 *
 * // Safe to use directly — errors appear in voice.error, never throw to callers
 * <button onClick={voice.status === "idle" ? voice.startVoice : voice.stopVoice}>
 *   {voice.status === "idle" ? "Start" : "Stop"}
 * </button>
 * {voice.error && <p className="voice-error-inline">{voice.error}</p>}
 * ```
 */
export function useEdgeClawVoice({
  agent,
  name = "default",
  host,
  enabled = true,
}: EdgeClawVoiceParams): EdgeClawVoiceState {
  // Resolve host before the hook call so the value is stable on the first
  // render even in environments where window initializes asynchronously.
  // The fallback is only needed defensively — this hook is browser-only.
  const resolvedHost = useMemo(
    () => host ?? (typeof window !== "undefined" ? window.location.host : "localhost"),
    [host],
  );

  // TEMP: [voice-dbg-client] — one wrapped transport per agent+session+host
  const debugTransport = useMemo(() => {
    if (!VOICE_CLIENT_DBG) return undefined;
    return createDebugWrappingTransport({
      agent,
      name,
      host: resolvedHost,
    });
  }, [agent, name, resolvedHost]);

  // ── Local error state ─────────────────────────────────────────────────────
  //
  // Captures errors thrown by startCall() that the Cloudflare SDK may not
  // route into its own `error` field (e.g. getUserMedia DOMExceptions fired
  // before the WebSocket handshake).  Cleared on the next successful call or
  // when stopVoice is called.
  const [localError, setLocalError] = useState<string | null>(null);

  // ── Core hook (always called — Rules of Hooks) ────────────────────────────
  //
  // useVoiceAgent creates a VoiceClient that opens a WebSocket on mount and
  // reconnects automatically.  The audio pipeline (mic capture + TTS playback)
  // does NOT start until startCall() is invoked, so this call is low-cost when
  // the user hasn't started a voice session.
  const {
    status,
    connected,
    isMuted,
    audioLevel,
    transcript,
    interimTranscript: sdkInterimTranscript,
    error: sdkError,
    metrics: sdkMetrics,
    lastCustomMessage: sdkLastCustom,
    startCall,
    endCall,
    toggleMute: rawToggleMute,
    sendText,
  } = useVoiceAgent({
    agent,
    name,
    host: resolvedHost,
    ...(debugTransport ? { transport: debugTransport } : {}),
    onReconnect: VOICE_CLIENT_DBG
      ? () => {
          console.info(`${VOICE_DBG} transport_reconnect agent=${agent} name=${name ?? "default"}`);
        }
      : undefined,
  });

  // ── Mute state refs (SDK mirror + in-flight intent) ────────────────────
  //
  // `isMuted` from the SDK is only available after the next render — so a ref
  // is updated in useEffect, *after* commit.  `setMuted` would otherwise be
  // able to read a stale isMuted and call `toggle` twice in quick succession
  // (double flip).  `desiredMutedRef` records the caller's *intent* the moment
  // we schedule a change; a second setMuted with the same intent short-circuits
  // even before the SDK state and the effect have caught up.
  const isMutedRef = useRef(isMuted);
  const desiredMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
    desiredMutedRef.current = isMuted;
  }, [isMuted]);

  // -- TEMP: [voice-dbg-client] — status / conn / errors / server metrics; remove with voiceDebugTransport
  const dbgStatusPrev = useRef<VoiceStatus | "">("");
  const dbgConnPrev = useRef<boolean | "">("");
  const dbgUnlockedNote = useRef(false);
  const dbgMetricsKey = useRef<string>("");
  const dbgCustomKey = useRef<string>("");
  useEffect(() => {
    if (!VOICE_CLIENT_DBG || !enabled) return;
    if (dbgStatusPrev.current === "") {
      console.info(
        `${VOICE_DBG} initial status=${status} connected=${connected} isMuted=${isMuted}`
      );
    } else if (dbgStatusPrev.current !== status) {
      console.info(
        `${VOICE_DBG} status from=${dbgStatusPrev.current} to=${status} connected=${connected} isMuted=${isMuted} ` +
          `hint=mic_upstream_mute_does_not_block_playback`
      );
    }
    dbgStatusPrev.current = status;
  }, [enabled, status, connected, isMuted]);
  useEffect(() => {
    if (!VOICE_CLIENT_DBG || !enabled) return;
    if (dbgConnPrev.current === "" || dbgConnPrev.current !== connected) {
      console.info(`${VOICE_DBG} connection connected=${connected} status=${status}`);
      if (connected && !dbgUnlockedNote.current) {
        dbgUnlockedNote.current = true;
        console.info(
          `${VOICE_DBG} playback: VoiceClient creates/resumes AudioContext(48k) when TTS decodes; ` +
            `if_silent_check_tab_mute_and_autoplay`
        );
      }
    }
    dbgConnPrev.current = connected;
  }, [enabled, connected, status]);
  const dbgErrPrev = useRef<string | null>(null);
  useEffect(() => {
    if (!VOICE_CLIENT_DBG || !enabled) return;
    const e = sdkError;
    if (e !== dbgErrPrev.current) {
      if (e) {
        console.info(`${VOICE_DBG} voice_err msg=${e}`);
      } else {
        console.info(`${VOICE_DBG} voice_err_clear`);
      }
    }
    dbgErrPrev.current = e;
  }, [enabled, sdkError]);
  useEffect(() => {
    if (!VOICE_CLIENT_DBG || !enabled) return;
    if (!sdkMetrics) return;
    const { llm_ms, tts_ms, first_audio_ms, total_ms } = sdkMetrics as {
      llm_ms?: number;
      tts_ms?: number;
      first_audio_ms?: number;
      total_ms?: number;
    };
    const k = [llm_ms, tts_ms, first_audio_ms, total_ms].join(",");
    if (k === dbgMetricsKey.current) return;
    dbgMetricsKey.current = k;
    console.info(
      `${VOICE_DBG} server_metrics ` +
        `llm_ms=${llm_ms ?? "n/a"} tts_ms=${tts_ms ?? "n/a"} ` +
        `first_audio_ms=${first_audio_ms ?? "n/a"} total_ms=${total_ms ?? "n/a"} ` +
        `note=SDK_metrics_after_voice_server_turn (confirms TTS path ran server-side)`
    );
  }, [enabled, sdkMetrics]);
  useEffect(() => {
    if (!VOICE_CLIENT_DBG || !enabled) return;
    if (sdkLastCustom == null) return;
    const k = (() => {
      try {
        return JSON.stringify(sdkLastCustom);
      } catch {
        return "non-json";
      }
    })();
    if (k === dbgCustomKey.current) return;
    dbgCustomKey.current = k;
    console.info(`${VOICE_DBG} lastCustomMessage`, sdkLastCustom);
  }, [enabled, sdkLastCustom]);
  const dbgLocalErrPrev = useRef<string | null>(null);
  useEffect(() => {
    if (!VOICE_CLIENT_DBG || !enabled) return;
    if (localError === dbgLocalErrPrev.current) return;
    if (localError) {
      console.info(`${VOICE_DBG} startCall_local_err msg=${localError}`);
    } else {
      console.info(`${VOICE_DBG} startCall_local_err_clear`);
    }
    dbgLocalErrPrev.current = localError;
  }, [enabled, localError]);
  // -- end TEMP [voice-dbg-client] --

  // ── Memoized action callbacks ─────────────────────────────────────────────

  /**
   * startVoice → useVoiceAgent().startCall
   *
   * Opens the mic and begins streaming PCM audio to the agent's transcriber.
   *
   * NEVER rejects to the caller.  All errors (mic denial, no device, network
   * failure) are caught, mapped to a human-readable message via formatVoiceError,
   * and stored in localError.  endCall() is also called so the SDK resets to
   * "idle" rather than being stranded in a partial "listening" state.
   */
  const startVoice = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    if (VOICE_CLIENT_DBG) {
      console.info(`${VOICE_DBG} startCall_begin`);
    }
    setLocalError(null);
    try {
      await startCall();
      if (VOICE_CLIENT_DBG) {
        console.info(
          `${VOICE_DBG} startCall_ok (mic+start_call) — if blocked see startCall_local_err in console`
        );
      }
    } catch (err) {
      // Map the raw error to readable copy and surface via the error field.
      // Then ensure the call is torn down so the SDK doesn't stay in a partial
      // "listening" state — endCall() is idempotent if the call never started.
      const readable = formatVoiceError(err);
      setLocalError(readable);
      if (VOICE_CLIENT_DBG) {
        console.error(`${VOICE_DBG} startCall_throw err=`, err);
      }
      console.error("[EdgeClaw][voice] startCall failed:", err);
      try {
        endCall();
      } catch {
        // endCall itself failed (no-op: cleanup is best-effort)
      }
    }
  }, [enabled, startCall, endCall]);

  /**
   * stopVoice → useVoiceAgent().endCall
   *
   * Tears down the audio pipeline (mic + TTS playback) without closing the
   * WebSocket.  Also clears any local error so the next call starts clean.
   */
  const stopVoice = useCallback((): void => {
    if (!enabled) return;
    if (VOICE_CLIENT_DBG) {
      console.info(`${VOICE_DBG} endCall (stop voice session)`);
    }
    setLocalError(null);
    endCall();
  }, [enabled, endCall]);

  /**
   * toggleMute → useVoiceAgent().toggleMute
   *
   * Mutes/unmutes the mic.  While muted the call stays alive so the agent can
   * still speak; audio frames are simply not forwarded to the server.
   */
  const toggleMute = useCallback((): void => {
    if (!enabled) return;
    if (VOICE_CLIENT_DBG) {
      console.info(
        `${VOICE_DBG} toggleMute (upstream only, playback/TTS from server is unchanged)`
      );
    }
    rawToggleMute();
  }, [enabled, rawToggleMute]);

  /**
   * setMuted(wantMuted) — idempotent mute setter.
   *
   * 1) If we already *intend* to be at `wantMuted` (desiredMutedRef), return —
   *    this catches duplicate back-to-back calls before the effect updates
   *    isMutedRef.
   * 2) Commit intent immediately: desiredMutedRef = wantMuted.
   * 3) If the last-known SDK state (isMutedRef) still disagrees, call toggle
   *    once.  When the SDK re-renders, the effect resyncs both refs from the
   *    single source of truth.  `toggleMute()` still only flips; the intent
   *    ref is what makes rapid duplicate setMuted() safe.
   */
  const setMuted = useCallback((wantMuted: boolean): void => {
    if (!enabled) return;

    if (desiredMutedRef.current === wantMuted) {
      return;
    }
    if (VOICE_CLIENT_DBG) {
      console.info(`${VOICE_DBG} setMuted want=${wantMuted} (mic upstream; not speaker)`);
    }
    desiredMutedRef.current = wantMuted;

    if (isMutedRef.current !== wantMuted) {
      rawToggleMute();
    }
  }, [enabled, rawToggleMute]);

  /**
   * sendVoiceText → useVoiceAgent().sendText
   *
   * Bypasses STT entirely — sends text directly into onTurn() on the agent.
   * TTS response streams back as normal.  Useful for typed input in a
   * voice-first UI that still wants voice output.
   */
  const sendVoiceText = useCallback((text: string): void => {
    if (!enabled) return;
    sendText(text);
  }, [enabled, sendText]);

  // ── Composed state object (memoized) ─────────────────────────────────────
  //
  // Stable object reference when nothing has changed — prevents unnecessary
  // re-renders in child components that receive this as a prop.

  return useMemo((): EdgeClawVoiceState => {
    // When disabled, return the idle baseline.  The underlying hook is still
    // running (required by Rules of Hooks) but its output is ignored.
    if (!enabled) {
      return {
        status: "idle",
        connected: false,
        isMuted: false,
        audioLevel: 0,
        displayMeterLevel: 0,
        transcript: EMPTY_TRANSCRIPT,
        interimTranscript: null,
        error: null,
        startVoice,
        stopVoice,
        toggleMute,
        setMuted,
        sendVoiceText,
      };
    }

    // Guard stale interim transcript: when the call is idle (either never
    // started or just ended) we always return null so the UI never shows a
    // frozen partial sentence from the previous call.
    const interimTranscript = status === "idle" ? null : sdkInterimTranscript;

    // Merge error sources — SDK error takes precedence since it may contain
    // richer context; local error fills the gap for errors that never reached
    // the SDK layer (e.g. getUserMedia failure before WebSocket handshake).
    const error = sdkError ?? localError;

    return {
      status,
      connected,
      isMuted,
      audioLevel,
      displayMeterLevel: mapVoiceRmsToDisplayMeter(audioLevel),
      // Use the stable empty array when the transcript is empty so that
      // reference equality checks in child components don't see a new array.
      transcript: transcript.length === 0 ? EMPTY_TRANSCRIPT : transcript,
      interimTranscript,
      error,
      startVoice,
      stopVoice,
      toggleMute,
      setMuted,
      sendVoiceText,
    };
  }, [
    enabled,
    status,
    connected,
    isMuted,
    audioLevel,
    transcript,
    sdkInterimTranscript,
    sdkError,
    localError,
    startVoice,
    stopVoice,
    toggleMute,
    setMuted,
    sendVoiceText,
  ]);
}
