import type { RevisionReasonCategory, TesterVerdict } from "./codingLoopTypes";

export function normalizeTesterFeedbackForComparison(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 8000);
}

export function inferRevisionReasonCategory(
  verdict: TesterVerdict,
  testerText: string
): RevisionReasonCategory {
  if (verdict === "pass") {
    return "tester_pass";
  }
  if (verdict === "unknown") {
    return "tester_unknown";
  }
  const t = testerText.toLowerCase();
  if (/\bcoverage\b/.test(t)) {
    return "coverage_gap";
  }
  if (/\brequirement\b/.test(t) || /\bspec\b/.test(t)) {
    return "requirements_mismatch";
  }
  return "tester_fail";
}

/** Stop when consecutive FAIL/UNKNOWN cycles produce identical normalized tester feedback. */
export function detectRepeatedFailure(
  previousNormalized: string,
  currentNormalized: string,
  streak: number
): { nextStreak: number; isRepeated: boolean } {
  if (!previousNormalized || !currentNormalized) {
    return { nextStreak: 1, isRepeated: false };
  }
  if (previousNormalized === currentNormalized) {
    const next = streak + 1;
    return { nextStreak: next, isRepeated: next >= 2 };
  }
  return { nextStreak: 1, isRepeated: false };
}
