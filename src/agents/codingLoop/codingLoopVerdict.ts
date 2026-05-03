import type { TesterVerdict } from "./codingLoopTypes";

/**
 * Parse a coarse PASS/FAIL from tester assistant prose.
 * Prefer explicit markers so sub-agents can cooperate deterministically without XML.
 */
export function parseTesterVerdict(text: string): TesterVerdict {
  const t = text.trim();
  if (!t) {
    return "unknown";
  }

  const upper = t.toUpperCase();

  const explicitMatch = /\bVERDICT\s*:\s*(PASS|FAIL)\b/i.exec(t);
  if (explicitMatch) {
    return explicitMatch[1].toUpperCase() === "PASS" ? "pass" : "fail";
  }

  if (/\bPASS\b/i.test(upper) && !/\bFAIL\b/i.test(upper)) {
    return "pass";
  }
  if (/\bFAIL\b/i.test(upper)) {
    return "fail";
  }

  if (/\bPASSED\b/i.test(upper) || /\bSUCCESS\b/i.test(upper) || /\bOK\b/i.test(upper)) {
    return "pass";
  }
  if (/\bFAILED\b/i.test(upper) || /\bERROR\b/i.test(upper)) {
    return "fail";
  }

  return "unknown";
}
