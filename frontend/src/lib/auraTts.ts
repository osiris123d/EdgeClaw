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
