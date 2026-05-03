/**
 * DO-level HTTP handler for /voice/* (TTS + Flux STT preferences).
 *
 * Worker proxy (see src/server.ts):
 *   - `POST /api/voice/tts-speaker?session=...` → body `{ "speaker": "asteria" }`
 *   - `POST /api/voice/tts-preview?session=...` → body `{ "speaker": "athena", "text"?: "…" }` → `audio/mpeg`
 *   - `POST /api/voice/flux-stt?session=...` → body `{ eotThreshold, eotTimeoutMs, eagerEotThreshold }`
 *
 * @see https://developers.cloudflare.com/workers-ai/models/aura-1/
 * @see https://developers.cloudflare.com/workers-ai/models/flux/
 */

import { isAuraTtsSpeaker } from "../lib/auraTts";

export interface VoiceFluxSttRequestBody {
  eotThreshold: number;
  eotTimeoutMs: number;
  /** `null` clears eager end-of-turn; omit in JSON only for partial updates (not used here). */
  eagerEotThreshold: number | null;
}

export interface VoiceRouteAdapter {
  applyAuraTtsSpeaker(speaker: string): { ok: boolean; error?: string };
  applyVoiceFluxStt(input: VoiceFluxSttRequestBody): { ok: boolean; error?: string };
  /** MP3 sample for Settings “Test voice” (see `POST /voice/tts-preview`). */
  previewTts(speaker: string, text?: string): Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle `/voice/*` POST for TTS speaker and Flux STT tuning.
 */
export async function handleVoiceRoute(
  request: Request,
  agent: VoiceRouteAdapter
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (
    !/^\/voice\/tts-speaker\/?$/.test(pathname) &&
    !/^\/voice\/flux-stt\/?$/.test(pathname) &&
    !/^\/voice\/tts-preview\/?$/.test(pathname)
  ) {
    return json({ error: "Not found" }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }

  const rec = body as Record<string, unknown>;

  if (/^\/voice\/tts-speaker\/?$/.test(pathname)) {
    const speaker = rec.speaker;
    if (typeof speaker !== "string" || !isAuraTtsSpeaker(speaker.trim().toLowerCase())) {
      return json(
        { error: "Invalid speaker — must be a valid @cf/deepgram/aura-1 speaker id." },
        400
      );
    }
    const result = agent.applyAuraTtsSpeaker(speaker.trim().toLowerCase());
    if (!result.ok) {
      return json({ error: result.error ?? "Failed to apply speaker" }, 500);
    }
    return json({ ok: true, speaker: speaker.trim().toLowerCase() });
  }

  if (/^\/voice\/tts-preview\/?$/.test(pathname)) {
    const speaker = rec.speaker;
    if (typeof speaker !== "string" || !isAuraTtsSpeaker(speaker.trim().toLowerCase())) {
      return json(
        { error: "Invalid or missing speaker — must be a valid @cf/deepgram/aura-1 speaker id." },
        400
      );
    }
    if (rec.text != null && typeof rec.text !== "string") {
      return json({ error: "text must be a string when provided" }, 400);
    }
    const t = rec.text == null ? undefined : rec.text;
    return await agent.previewTts(speaker.trim().toLowerCase(), t);
  }

  // /voice/flux-stt
  if (rec.eotThreshold == null || rec.eotTimeoutMs == null) {
    return json(
      { error: "eotThreshold and eotTimeoutMs are required; eagerEotThreshold may be null." },
      400
    );
  }
  if (typeof rec.eotThreshold !== "number" || !Number.isFinite(rec.eotThreshold)) {
    return json({ error: "eotThreshold must be a finite number" }, 400);
  }
  if (typeof rec.eotTimeoutMs !== "number" || !Number.isFinite(rec.eotTimeoutMs)) {
    return json({ error: "eotTimeoutMs must be a finite number" }, 400);
  }
  if (
    rec.eagerEotThreshold != null
    && (typeof rec.eagerEotThreshold !== "number" || !Number.isFinite(rec.eagerEotThreshold))
  ) {
    return json({ error: "eagerEotThreshold must be a finite number or null" }, 400);
  }

  const result = agent.applyVoiceFluxStt({
    eotThreshold: rec.eotThreshold,
    eotTimeoutMs: rec.eotTimeoutMs,
    eagerEotThreshold: rec.eagerEotThreshold as number | null,
  });
  if (!result.ok) {
    return json({ error: result.error ?? "Failed to apply Flux STT options" }, 500);
  }
  return json({ ok: true });
}
