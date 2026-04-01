import { describe, expect, it } from "vitest";
import { classifyDeterministic } from "../../src/agents/DispatcherAgent";

describe("classifyDeterministic", () => {
  it("classifies NAC policy + CAB request as change_review/nac", () => {
    const result = classifyDeterministic("Review NAC policy change and draft CAB notes");
    expect(result.taskType).toBe("change_review");
    expect(result.domain).toBe("nac");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("classifies weekly report draft request", () => {
    const result = classifyDeterministic("Create a weekly network report draft for leadership");
    expect(result.taskType).toBe("report_draft");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("classifies outage text as incident triage in wifi domain", () => {
    const result = classifyDeterministic("We have a WiFi outage and AP authentication failures");
    expect(result.taskType).toBe("incident_triage");
    expect(result.domain).toBe("wifi");
  });

  it("falls back to cross_domain when no domain signals are present", () => {
    const result = classifyDeterministic("Please review this vague request");
    expect(result.domain).toBe("cross_domain");
    expect(result.confidence).toBeGreaterThanOrEqual(0.35);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });
});
