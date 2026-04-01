import { describe, expect, it } from "vitest";
import {
  keyKnowledgeDoc,
  keyTask,
  keyTaskArtifact,
  keyTaskArtifactsPrefix,
  keyUserProfile,
  keyWorklogEntry,
  keyWorklogPrefix,
} from "../../src/lib/r2";

describe("R2 key generation", () => {
  it("builds task and worklog keys under org/hilton prefix", () => {
    expect(keyTask("task-123")).toBe("org/hilton/tasks/task-123/task.json");
    expect(keyWorklogPrefix("task-123")).toBe("org/hilton/tasks/task-123/worklog/");
    expect(keyWorklogEntry("task-123", "entry-1")).toBe(
      "org/hilton/tasks/task-123/worklog/entry-1.json"
    );
  });

  it("sanitizes spacing and leading/trailing slashes", () => {
    expect(keyTask(" /task one/ ")).toBe("org/hilton/tasks/task_one/task.json");
    expect(keyTaskArtifact("task one", " screenshot one ")).toBe(
      "org/hilton/tasks/task_one/artifacts/screenshot_one"
    );
  });

  it("builds artifact/knowledge/user keys deterministically", () => {
    expect(keyTaskArtifactsPrefix("task-abc")).toBe("org/hilton/tasks/task-abc/artifacts/");
    expect(keyKnowledgeDoc("wifi", "playbooks", "triage-v1.json")).toBe(
      "org/hilton/knowledge/wifi/playbooks/triage-v1.json"
    );
    expect(keyUserProfile("user-007")).toBe("org/hilton/users/user-007/profile.json");
  });
});
