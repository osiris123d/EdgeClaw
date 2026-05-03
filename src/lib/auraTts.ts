/**
 * @cf/deepgram/aura-1 speaker IDs (Workers AI TTS).
 * @see https://developers.cloudflare.com/workers-ai/models/aura-1/
 */
export const AURA_TTS_SPEAKERS = [
  "angus",
  "asteria",
  "arcas",
  "orion",
  "orpheus",
  "athena",
  "luna",
  "zeus",
  "perseus",
  "helios",
  "hera",
  "stella",
] as const;

export type AuraTtsSpeaker = (typeof AURA_TTS_SPEAKERS)[number];

export const DEFAULT_AURA_TTS_SPEAKER: AuraTtsSpeaker = "asteria";

const SPEAKER_SET = new Set<string>(AURA_TTS_SPEAKERS);

export function isAuraTtsSpeaker(value: string): value is AuraTtsSpeaker {
  return SPEAKER_SET.has(value);
}

export function parseAuraTtsSpeaker(raw: unknown): AuraTtsSpeaker | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return isAuraTtsSpeaker(v) ? v : undefined;
}
