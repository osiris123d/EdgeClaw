import { InMemorySharedWorkspaceStorage } from "../agents/codingLoop/testFixtures/inMemorySharedWorkspaceStorage";
import { ORCHESTRATION_DEBUG_SHARED_PROJECT_ID } from "../debug/orchestrationDebugProjectId";

/**
 * Stable id for the in-memory shared workspace used by `runOrchestrationSandbox.ts`.
 * Documented in `fixtures/sandbox-orchestration-micro/README.md` — not a production project.
 */
export const SANDBOX_ORCHESTRATION_MICRO_PROJECT_ID = ORCHESTRATION_DEBUG_SHARED_PROJECT_ID;

/** Seed canonical + staging files for orchestration sandbox runs (in-memory only). */
export async function seedOrchestrationMicroFixture(
  storage: InMemorySharedWorkspaceStorage,
  projectId: string = SANDBOX_ORCHESTRATION_MICRO_PROJECT_ID
): Promise<void> {
  await storage.writeProjectFile(
    projectId,
    "README.md",
    "# Micro fixture\nIn-repo sandbox only. Coder policy: writes under staging/ and patch proposals only.\n"
  );
  await storage.writeProjectFile(
    projectId,
    "staging/handoff.md",
    "# Handoff\nUse shared_workspace_put_patch for change proposals.\n"
  );
}
