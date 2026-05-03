import type { SubAgentResult } from "../delegation";
import {
  detectRepeatedFailure,
  inferRevisionReasonCategory,
  normalizeTesterFeedbackForComparison,
} from "./codingLoopPolicies";
import { resolveActivePatchIdsForVerification } from "./codingLoopPatchScope";
import type {
  CodingCollaborationLoopHost,
  CodingCollaborationLoopInput,
  CodingCollaborationLoopResult,
  CodingIterationRecord,
  CodingLoopTerminalStatus,
  CodingSubagentTurnAuditEntry,
  ManagerIterationDecision,
  StructuredRevisionContext,
  SubAgentTurnSummary,
  TesterVerdict,
} from "./codingLoopTypes";
import { diffNewPending, listPendingPatchIds } from "./codingLoopPatchSync";
import { parseTesterVerdict } from "./codingLoopVerdict";
import { resolveCodingLoopBlueprintInjection } from "./resolveBlueprintInjectionForCodingLoop";
import { isDurableObjectCodeUpdateResetError } from "./codingLoopTransientErrors";

const SUBAGENT_AUDIT_PREVIEW_MAX = 2000;

function truncateForSubagentAudit(text: string, max = SUBAGENT_AUDIT_PREVIEW_MAX): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function extractTesterVerdictLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line && /VERDICT\s*:/i.test(line)) return line;
  }
  return undefined;
}

function summarizeTurn(r: SubAgentResult): SubAgentTurnSummary {
  return {
    ok: r.ok,
    error: r.error,
    textLen: r.text.length,
    eventCount: r.events.length,
  };
}

function clampIterations(n: number | undefined): number {
  const x = n ?? 5;
  return Math.min(Math.max(x, 1), 20);
}

/** Serializable options only — never pass `AbortSignal` or callbacks across sub-agent RPC. */
function buildSubAgentDelegationOptions(
  host: CodingCollaborationLoopHost,
  input: CodingCollaborationLoopInput,
  subAgentInstanceSuffix: string
): import("../delegation").DelegationOptions {
  const runId =
    (typeof input.controlPlaneRunId === "string" && input.controlPlaneRunId.trim()
      ? input.controlPlaneRunId.trim()
      : undefined) ?? host.loopRunId;
  return {
    sharedProjectId: input.sharedProjectId,
    subAgentInstanceSuffix,
    ...(input.statelessSubAgentModelTurn === true
      ? { statelessSubAgentModelTurn: true as const }
      : {}),
    ...(input.debugDisableSharedWorkspaceTools === true
      ? { debugDisableSharedWorkspaceTools: true as const }
      : {}),
    ...(input.controlPlaneProjectId?.trim()
      ? { controlPlaneProjectId: input.controlPlaneProjectId.trim() }
      : {}),
    ...(input.controlPlaneTaskId?.trim()
      ? { controlPlaneTaskId: input.controlPlaneTaskId.trim() }
      : {}),
    controlPlaneRunId: runId,
  };
}

function legacyLoopDecision(m: ManagerIterationDecision): CodingIterationRecord["loopDecision"] {
  switch (m) {
    case "continue_revision":
      return "sent_revision_to_coder";
    case "approve_and_apply_scoped":
    case "stop_success_applied":
      return "applied_patches";
    case "waiting_for_user_approval":
    case "approve_scoped_only":
    case "pass_no_scoped_pending":
    case "stop_success_approved_pending_apply":
      return "waiting_for_user_approval";
    default:
      return "failed_or_aborted";
  }
}

function buildOperatorRevisionBlock(note: string | undefined): string {
  const t = typeof note === "string" ? note.trim() : "";
  if (!t) return "";
  return (
    `--- Operator revision directive (must address before considering work complete) ---\n` +
    `${t}\n` +
    `--- end operator revision directive ---\n\n`
  );
}

/** Keep child chat small; orchestrator reads patches/staging via shared_workspace_* tools. */
const CODER_ORCHESTRATION_OUTPUT_DISCIPLINE = `

--- Orchestration reply discipline (mandatory) ---
- Put substantive work in the shared workspace only: staging files under staging/ and pending patches via shared_workspace_put_patch (and related list/read tools). Do **not** paste large code, full unified diffs, or whole files in this chat.
- In prose: a short status (what you did / patch ids / blockers). The parent will inspect the workspace; it does not need a transcript-sized reply here.
`;

const TESTER_ORCHESTRATION_OUTPUT_DISCIPLINE = `

--- Orchestration reply discipline (mandatory) ---
- Use tools to read patches and staging files; quote only short snippets when needed. Do **not** paste entire patch bodies or large files in chat.
- Keep reasoning concise; you must still end with exactly: VERDICT: PASS or VERDICT: FAIL (see below).
`;

/** Tester instructions: explicit blueprint / contract checks (coding-loop verification turns). */
const TESTER_BLUEPRINT_CONFORMANCE_BLOCK = `Blueprint conformance (mandatory):
- Compare proposed patches and any implementation you can read against the **acceptance criteria** in the orchestrator task block.
- When the blueprint bundle includes **DATA_MODELS.md**, treat documented field types and nullability as **contracts**. Example: if a field is documented as \`string\` and the implementation uses \`string | null\` or allows null without the blueprint explicitly marking it optional/nullable, treat that as a **contract mismatch** → **VERDICT: FAIL** unless the blueprint text clearly allows null/optional for that field.
- When **API_DESIGN.md** (or **PROJECT_SPEC.md**) is present, HTTP paths, methods, payloads, and response shapes must match. Do not rationalize silent divergence: call out mismatches in your reasoning.
- If you find a contract or schema mismatch, **FAIL** the verification (do not PASS because the change “seems reasonable”). The orchestrator will send a revision to the coder.

`;

function buildTesterPrompt(
  sharedProjectId: string,
  iteration: number,
  verifyPatchIds: string[],
  blueprintContextMarkdown: string | undefined,
  operatorRevisionNote: string | undefined
): string {
  const scopeLine =
    verifyPatchIds.length > 0
      ? `Focus verification on these pending patch id(s): ${verifyPatchIds.join(", ")}. ` +
        `If none exist or ids are stale, still inspect the workspace and explain gaps.\n`
      : `No specific patch ids scoped — review all pending proposals for this project.\n`;
  const bp = blueprintContextMarkdown?.trim();
  const blueprintBlock =
    bp && bp.length > 0
      ? `--- Project blueprint (control plane; reference for iteration ${iteration}) ---\n${bp}\n\n`
      : "";
  const opBlock = buildOperatorRevisionBlock(operatorRevisionNote);
  return (
    opBlock +
    blueprintBlock +
    TESTER_BLUEPRINT_CONFORMANCE_BLOCK +
    TESTER_ORCHESTRATION_OUTPUT_DISCIPLINE +
    `Shared project id: ${sharedProjectId} (iteration ${iteration}).\n` +
    scopeLine +
    `Review the shared workspace: list patches (shared_workspace_list_patches), ` +
    `read proposed patches (shared_workspace_get_patch), read relevant files (shared_workspace_read). ` +
    `Do not approve or apply patches — report evidence only.\n` +
    `Report whether the implementation satisfies the task from the orchestrator's perspective.\n` +
    `End your reply with a single line exactly: VERDICT: PASS or VERDICT: FAIL, plus brief reasoning above it.`
  );
}

function buildStructuredRevisionBlock(ctx: StructuredRevisionContext): string {
  return (
    `--- structured_revision_context (machine-readable) ---\n` +
    `${JSON.stringify(ctx, null, 2)}\n` +
    `--- end structured_revision_context ---`
  );
}

function buildCoderMessageForIteration(
  iteration: number,
  task: string,
  structuredCtx: StructuredRevisionContext | null,
  revisionTesterText: string
): string {
  if (iteration === 1) {
    return task + CODER_ORCHESTRATION_OUTPUT_DISCIPLINE;
  }
  const structured = structuredCtx ? `${buildStructuredRevisionBlock(structuredCtx)}\n\n` : "";
  return (
    `${structured}` +
    `The tester reported issues or failure. Address the feedback below and propose updated patches ` +
    `(shared_workspace_put_patch) or staging files under staging/ only.\n\n` +
    `--- Tester output ---\n${revisionTesterText.slice(0, 12_000)}\n\n` +
    `--- Original task ---\n${task}` +
    CODER_ORCHESTRATION_OUTPUT_DISCIPLINE
  );
}

/** Targets orchestrator can approve/apply on PASS — respects tester scope when not applying full pending. */
function resolveApplyTargets(input: {
  applyAllPendingOnPass: boolean;
  activePatchIdsForIteration: string[];
  pendingAfterCoder: string[];
  newPending: string[];
}): string[] {
  const pending = input.pendingAfterCoder;
  if (input.applyAllPendingOnPass) {
    return [...pending];
  }
  const scope = new Set(input.activePatchIdsForIteration);
  const scopedPending = pending.filter((id) => scope.has(id));
  if (scopedPending.length > 0) {
    return scopedPending;
  }
  const scopedNew = input.newPending.filter((id) => scope.has(id));
  if (scopedNew.length > 0) {
    return scopedNew;
  }
  return pending.filter((id) => scope.has(id));
}

function excludeStaleFromTargets(targets: string[], stale: ReadonlySet<string>): string[] {
  return targets.filter((id) => !stale.has(id));
}

async function approvePendingPatches(
  gateway: import("../../workspace/sharedWorkspaceTypes").SharedWorkspaceGateway,
  projectId: string,
  patchIds: string[],
  log: CodingCollaborationLoopHost["log"]
): Promise<{ ok: true } | { error: string }> {
  for (const patchId of patchIds) {
    const ap = await gateway.approvePatch("orchestrator", projectId, patchId);
    if ("error" in ap) {
      log("coding_loop.patch_approve_failed", { projectId, patchId, error: ap.error });
      return { error: ap.error };
    }
    log("coding_loop.patch_approved", { projectId, patchId });
  }
  return { ok: true };
}

async function applyApprovedPatches(
  gateway: import("../../workspace/sharedWorkspaceTypes").SharedWorkspaceGateway,
  projectId: string,
  patchIds: string[],
  log: CodingCollaborationLoopHost["log"]
): Promise<{ ok: true } | { error: string }> {
  for (const patchId of patchIds) {
    const app = await gateway.applyPatch("orchestrator", projectId, patchId);
    if ("error" in app) {
      log("coding_loop.patch_apply_failed", { projectId, patchId, error: app.error });
      return { error: app.error };
    }
    log("coding_loop.patch_applied", { projectId, patchId });
  }
  return { ok: true };
}

async function emitIteration(
  input: CodingCollaborationLoopInput,
  record: CodingIterationRecord
): Promise<void> {
  await input.onIterationComplete?.(record);
}

/**
 * Interactive coding collaboration loop (manager → coder → tester → manager).
 *
 * **Workflow extension:** invoke from a Workflow step with persisted `loopRunId` / iteration index for resume.
 */
export async function runCodingCollaborationLoop(
  host: CodingCollaborationLoopHost,
  rawInput: CodingCollaborationLoopInput
): Promise<CodingCollaborationLoopResult> {
  const { input, assembly: blueprintContextAssembly } = resolveCodingLoopBlueprintInjection(rawInput);
  if (blueprintContextAssembly) {
    host.log("coding_loop.blueprint_context_assembly", { mode: blueprintContextAssembly });
    console.info(`blueprint_context_assembly=${blueprintContextAssembly}`);
  }

  const maxIterations = clampIterations(input.maxIterations);
  const gateway = host.getOrchestratorGateway();
  const exitOnPass =
    input.exitOnPassWithoutAutoApply !== undefined ? input.exitOnPassWithoutAutoApply : true;
  const unknownPolicy = input.unknownVerdictPolicy ?? "fail";
  const scopeTesterToNewPatchesOnly = input.scopeTesterToNewPatchesOnly !== false;
  const stopOnRepeated = input.stopOnRepeatedIdenticalFailures !== false;
  const stopOnNoNew = input.stopOnNoNewPatches === true;
  const staleThreshold = input.stalePatchIterationThreshold;

  /** Applying patches requires an approved lifecycle state — auto-approve when apply is requested. */
  const effectiveAutoApprove =
    input.autoApplyVerifiedPatches === true ? true : input.autoApproveOnPass === true;

  const iterations: CodingIterationRecord[] = [];
  const subagentTurnAudit: CodingSubagentTurnAuditEntry[] = [];

  let revisionTesterText = "";
  let structuredRevisionHint: StructuredRevisionContext | null = null;

  const patchFirstSeenIteration = new Map<string, number>();

  let failureStreak = 0;
  let previousFailureNormalized = "";

  if (!gateway) {
    host.log("coding_loop.blocked", { reason: "no_shared_workspace_gateway" });
    return finalize(
      "blocked_no_shared_workspace",
      iterations,
      host,
      input.sharedProjectId,
      "Shared workspace is not configured (missing SHARED_WORKSPACE_KV). Bind KV before running the coding loop.",
      undefined,
      blueprintContextAssembly,
      undefined
    );
  }

  const bpRaw = input.blueprintContextMarkdown?.trim();
  const blueprintPrefix =
    bpRaw && bpRaw.length > 0
      ? "--- control_plane_blueprint_context (reference; not executable code) ---\n" +
        bpRaw +
        "\n--- end control_plane_blueprint_context ---\n\n"
      : "";
  const operatorBlock = buildOperatorRevisionBlock(input.operatorRevisionNote);
  const seedTask =
    blueprintPrefix || operatorBlock
      ? `${blueprintPrefix}${operatorBlock}${input.task}`
      : input.task;

  const childTurnModeLog = input.statelessSubAgentModelTurn === true ? "stateless" : "normal";
  const sharedToolsLog = input.debugDisableSharedWorkspaceTools === true ? "disabled" : "enabled";
  console.info(`child_turn_mode=${childTurnModeLog}`);
  console.info(`child_shared_workspace_tools=${sharedToolsLog}`);
  host.log("coding_loop.child_turn_config", {
    child_turn_mode: childTurnModeLog,
    child_shared_workspace_tools: sharedToolsLog,
  });

  let pendingSnapshot = await listPendingPatchIds(gateway, input.sharedProjectId);

  for (let i = 1; i <= maxIterations; i++) {
    if (input.signal?.aborted) {
      host.log("coding_loop.aborted", { iteration: i });
      return finalize(
        "stopped_aborted",
        iterations,
        host,
        input.sharedProjectId,
        "Loop aborted by signal.",
        i - 1,
        undefined,
        subagentTurnAudit
      );
    }

    const suffix = `${host.loopRunId}-i${i}`;
    host.log("coding_loop.iteration_start", {
      iteration: i,
      maxIterations,
      subAgentSuffix: suffix,
      sharedProjectId: input.sharedProjectId,
      parentRequestId: host.parentRequestId,
    });

    const coderMessage = buildCoderMessageForIteration(
      i,
      seedTask,
      structuredRevisionHint,
      revisionTesterText
    );

    let coderResult = await host.delegateToCoder(
      coderMessage,
      buildSubAgentDelegationOptions(host, input, suffix)
    );
    if (!coderResult.ok && isDurableObjectCodeUpdateResetError(coderResult.error)) {
      host.log("coding_loop.coder_retry_after_do_code_reset", { iteration: i });
      coderResult = await host.delegateToCoder(
        coderMessage,
        buildSubAgentDelegationOptions(host, input, `${suffix}-retry1`)
      );
    }

    if (!coderResult.ok) {
      subagentTurnAudit.push({
        iteration: i,
        role: "coder",
        promptCharCount: coderMessage.length,
        promptPreview: truncateForSubagentAudit(coderMessage),
        responseCharCount: (coderResult.text ?? "").length,
        responsePreview: truncateForSubagentAudit(
          coderResult.text || coderResult.error || "(no body)"
        ),
      });
      const record = iterationRecordFailed(
        i,
        suffix,
        summarizeTurn(coderResult),
        { ok: false, textLen: 0, eventCount: 0, error: "skipped" },
        [],
        [],
        [],
        [],
        "unknown",
        "tester_unknown",
        "stop_failure_subagent"
      );
      iterations.push(record);
      await emitIteration(input, record);
      return finalize(
        "completed_failure",
        iterations,
        host,
        input.sharedProjectId,
        `Coder sub-agent failed: ${coderResult.error ?? "unknown error"}`,
        undefined,
        blueprintContextAssembly,
        subagentTurnAudit
      );
    }

    subagentTurnAudit.push({
      iteration: i,
      role: "coder",
      promptCharCount: coderMessage.length,
      promptPreview: truncateForSubagentAudit(coderMessage),
      responseCharCount: coderResult.text.length,
      responsePreview: truncateForSubagentAudit(coderResult.text),
    });

    const pendingAfterCoder = await listPendingPatchIds(gateway, input.sharedProjectId);
    const newPending = diffNewPending(pendingSnapshot, pendingAfterCoder);
    pendingSnapshot = pendingAfterCoder;

    for (const pid of pendingAfterCoder) {
      if (!patchFirstSeenIteration.has(pid)) {
        patchFirstSeenIteration.set(pid, i);
      }
    }

    const stalePendingPatchIds: string[] = [];
    const staleSet = new Set<string>();
    if (staleThreshold != null && staleThreshold > 0) {
      for (const pid of pendingAfterCoder) {
        const first = patchFirstSeenIteration.get(pid) ?? i;
        if (i - first >= staleThreshold) {
          stalePendingPatchIds.push(pid);
          staleSet.add(pid);
        }
      }
    }

    host.log("coding_loop.coder_done", {
      iteration: i,
      pendingPatchCount: pendingAfterCoder.length,
      newPendingPatchIds: newPending,
    });

    if (stopOnNoNew && i >= 2 && newPending.length === 0) {
      const record = iterationRecordStub(
        i,
        suffix,
        summarizeTurn(coderResult),
        { ok: false, textLen: 0, eventCount: 0, error: "skipped_no_new_patches" },
        pendingAfterCoder,
        newPending,
        [],
        stalePendingPatchIds,
        "unknown",
        "other",
        "stop_guardrail_no_new_patches"
      );
      iterations.push(record);
      await emitIteration(input, record);
      return finalize(
        "stopped_no_new_patches",
        iterations,
        host,
        input.sharedProjectId,
        "Coder produced no new pending patches this iteration (stopOnNoNewPatches).",
        i,
        blueprintContextAssembly,
        subagentTurnAudit
      );
    }

    const activePatchIdsForIteration = resolveActivePatchIdsForVerification({
      focusPatchIds: input.focusPatchIds,
      scopeTesterToNewPatchesOnly,
      newPendingPatchIds: newPending,
      pendingAfterCoder,
    });

    const testerMessage = buildTesterPrompt(
      input.sharedProjectId,
      i,
      activePatchIdsForIteration,
      input.blueprintContextMarkdown,
      input.operatorRevisionNote
    );
    let testerResult = await host.delegateToTester(
      testerMessage,
      buildSubAgentDelegationOptions(host, input, suffix)
    );
    if (!testerResult.ok && isDurableObjectCodeUpdateResetError(testerResult.error)) {
      host.log("coding_loop.tester_retry_after_do_code_reset", { iteration: i });
      testerResult = await host.delegateToTester(
        testerMessage,
        buildSubAgentDelegationOptions(host, input, `${suffix}-retry1`)
      );
    }

    if (!testerResult.ok) {
      subagentTurnAudit.push({
        iteration: i,
        role: "tester",
        promptCharCount: testerMessage.length,
        promptPreview: truncateForSubagentAudit(testerMessage),
        responseCharCount: (testerResult.text ?? "").length,
        responsePreview: truncateForSubagentAudit(
          testerResult.text || testerResult.error || "(no body)"
        ),
      });
      const record = iterationRecordStub(
        i,
        suffix,
        summarizeTurn(coderResult),
        summarizeTurn(testerResult),
        pendingAfterCoder,
        newPending,
        activePatchIdsForIteration,
        stalePendingPatchIds,
        "unknown",
        "tester_unknown",
        "stop_failure_subagent"
      );
      iterations.push(record);
      await emitIteration(input, record);
      return finalize(
        "completed_failure",
        iterations,
        host,
        input.sharedProjectId,
        `Tester sub-agent failed: ${testerResult.error ?? "unknown error"}`,
        undefined,
        blueprintContextAssembly,
        subagentTurnAudit
      );
    }

    subagentTurnAudit.push({
      iteration: i,
      role: "tester",
      promptCharCount: testerMessage.length,
      promptPreview: truncateForSubagentAudit(testerMessage),
      responseCharCount: testerResult.text.length,
      responsePreview: truncateForSubagentAudit(testerResult.text),
      testerVerdictLine: extractTesterVerdictLine(testerResult.text),
    });

    let verdict: TesterVerdict = parseTesterVerdict(testerResult.text);
    if (verdict === "unknown" && unknownPolicy === "pass") {
      verdict = "pass";
    }

    const revisionCat = inferRevisionReasonCategory(verdict, testerResult.text);
    const verdictScope: CodingIterationRecord["testerVerdictScope"] =
      activePatchIdsForIteration.length > 0 ? "patch_set" : "project_wide_note";

    host.log("coding_loop.tester_done", {
      iteration: i,
      verdict,
      testerTextLen: testerResult.text.length,
      activePatchIdsForIteration,
    });

    if (verdict === "pass") {
      failureStreak = 0;
      previousFailureNormalized = "";
    } else {
      const curNorm = normalizeTesterFeedbackForComparison(testerResult.text);
      const { nextStreak, isRepeated } = detectRepeatedFailure(
        previousFailureNormalized,
        curNorm,
        failureStreak
      );
      failureStreak = nextStreak;
      previousFailureNormalized = curNorm;

      if (stopOnRepeated && isRepeated) {
        const record = iterationRecordCore(
          i,
          suffix,
          summarizeTurn(coderResult),
          summarizeTurn(testerResult),
          pendingAfterCoder,
          newPending,
          activePatchIdsForIteration,
          stalePendingPatchIds,
          verdict,
          verdictScope,
          revisionCat,
          "stop_guardrail_repeated_failure"
        );
        iterations.push(record);
        await emitIteration(input, record);
        return finalize(
          "stopped_repeated_failure",
          iterations,
          host,
          input.sharedProjectId,
          "Tester produced the same normalized failure feedback twice in a row — stopping.",
          i,
          blueprintContextAssembly,
          subagentTurnAudit
        );
      }
    }

    if (verdict === "fail" || verdict === "unknown") {
      revisionTesterText = testerResult.text;
      structuredRevisionHint = {
        iteration: i,
        revisionReasonCategory: revisionCat,
        testerFeedbackExcerpt: testerResult.text.slice(0, 4000),
        verificationPatchIds: activePatchIdsForIteration,
        testerVerdict: verdict,
      };

      const record = iterationRecordCore(
        i,
        suffix,
        summarizeTurn(coderResult),
        summarizeTurn(testerResult),
        pendingAfterCoder,
        newPending,
        activePatchIdsForIteration,
        stalePendingPatchIds,
        verdict,
        verdictScope,
        revisionCat,
        "continue_revision"
      );
      iterations.push(record);
      await emitIteration(input, record);

      if (i === maxIterations) {
        return finalize(
          "stopped_max_iterations",
          iterations,
          host,
          input.sharedProjectId,
          `Stopped after ${maxIterations} iterations — tester still reports failure or unclear verdict.`,
          i,
          blueprintContextAssembly,
          subagentTurnAudit
        );
      }
      continue;
    }

    let targets = resolveApplyTargets({
      applyAllPendingOnPass: input.applyAllPendingOnPass === true,
      activePatchIdsForIteration,
      pendingAfterCoder,
      newPending,
    });
    targets = excludeStaleFromTargets(targets, staleSet);

    const anyApproveOrApply =
      effectiveAutoApprove || input.autoApplyVerifiedPatches === true;

    if (!anyApproveOrApply) {
      const record = iterationRecordCore(
        i,
        suffix,
        summarizeTurn(coderResult),
        summarizeTurn(testerResult),
        pendingAfterCoder,
        newPending,
        activePatchIdsForIteration,
        stalePendingPatchIds,
        verdict,
        verdictScope,
        revisionCat,
        exitOnPass ? "waiting_for_user_approval" : "continue_revision"
      );
      iterations.push(record);
      await emitIteration(input, record);

      if (exitOnPass) {
        return finalize(
          "needs_user_approval",
          iterations,
          host,
          input.sharedProjectId,
          `Tester PASS. Scoped pending patches to review/approve: ${targets.join(", ") || "(none)"}. ` +
            `Orchestrator approval/apply disabled — use shared_workspace_* tools or re-run with auto approve/apply.`,
          i,
          blueprintContextAssembly,
          subagentTurnAudit
        );
      }

      revisionTesterText =
        "Tester PASS — refine coverage or docs if needed." +
        (targets.length ? ` Scoped patch ids: ${targets.join(", ")}.` : "");
      structuredRevisionHint = {
        iteration: i,
        revisionReasonCategory: "tester_pass",
        testerFeedbackExcerpt: revisionTesterText,
        verificationPatchIds: activePatchIdsForIteration,
        testerVerdict: "pass",
      };

      if (i === maxIterations) {
        return finalize(
          "stopped_max_iterations",
          iterations,
          host,
          input.sharedProjectId,
          "Max iterations reached after PASS without orchestrator approve/apply.",
          i,
          blueprintContextAssembly,
          subagentTurnAudit
        );
      }
      continue;
    }

    if (targets.length === 0) {
      const record = iterationRecordCore(
        i,
        suffix,
        summarizeTurn(coderResult),
        summarizeTurn(testerResult),
        pendingAfterCoder,
        newPending,
        activePatchIdsForIteration,
        stalePendingPatchIds,
        verdict,
        verdictScope,
        revisionCat,
        "pass_no_scoped_pending"
      );
      iterations.push(record);
      await emitIteration(input, record);
      return finalize(
        "completed_success",
        iterations,
        host,
        input.sharedProjectId,
        "Tester PASS — no scoped pending patches to approve (check stale exclusion or scope).",
        i,
        blueprintContextAssembly,
        subagentTurnAudit
      );
    }

    let approveRes: { ok: true } | { error: string } = { ok: true };
    if (effectiveAutoApprove) {
      approveRes = await approvePendingPatches(gateway, input.sharedProjectId, targets, host.log);
    }

    if ("error" in approveRes) {
      const record = iterationRecordCore(
        i,
        suffix,
        summarizeTurn(coderResult),
        summarizeTurn(testerResult),
        pendingAfterCoder,
        newPending,
        activePatchIdsForIteration,
        stalePendingPatchIds,
        verdict,
        verdictScope,
        revisionCat,
        "stop_failure_subagent"
      );
      iterations.push(record);
      await emitIteration(input, record);
      return finalize(
        "completed_failure",
        iterations,
        host,
        input.sharedProjectId,
        `Tester PASS but approve failed: ${approveRes.error}`,
        i,
        blueprintContextAssembly
      );
    }

    if (!input.autoApplyVerifiedPatches) {
      const record = iterationRecordCore(
        i,
        suffix,
        summarizeTurn(coderResult),
        summarizeTurn(testerResult),
        pendingAfterCoder,
        newPending,
        activePatchIdsForIteration,
        stalePendingPatchIds,
        verdict,
        verdictScope,
        revisionCat,
        "stop_success_approved_pending_apply"
      );
      iterations.push(record);
      await emitIteration(input, record);
      return finalize(
        "completed_success",
        iterations,
        host,
        input.sharedProjectId,
        `Tester PASS. Approved (not applied): ${targets.join(", ")}. Apply via gateway or enable autoApplyVerifiedPatches.`,
        i,
        blueprintContextAssembly,
        subagentTurnAudit
      );
    }

    const applyRes = await applyApprovedPatches(gateway, input.sharedProjectId, targets, host.log);
    const record = iterationRecordCore(
      i,
      suffix,
      summarizeTurn(coderResult),
      summarizeTurn(testerResult),
      pendingAfterCoder,
      newPending,
      activePatchIdsForIteration,
      stalePendingPatchIds,
      verdict,
      verdictScope,
      revisionCat,
      "error" in applyRes ? "stop_failure_subagent" : "stop_success_applied"
    );
    iterations.push(record);
    await emitIteration(input, record);

    if ("error" in applyRes) {
      return finalize(
        "completed_failure",
        iterations,
        host,
        input.sharedProjectId,
        `Tester PASS but apply failed: ${applyRes.error}`,
        i,
        blueprintContextAssembly,
        subagentTurnAudit
      );
    }

    return finalize(
      "completed_success",
      iterations,
      host,
      input.sharedProjectId,
      `Tester PASS. Approved + applied: ${targets.join(", ")}.`,
      i,
      blueprintContextAssembly,
      subagentTurnAudit
    );
  }

  return finalize(
    "stopped_max_iterations",
    iterations,
    host,
    input.sharedProjectId,
    `Stopped after ${maxIterations} iterations without completion.`,
    maxIterations,
    blueprintContextAssembly,
    subagentTurnAudit
  );
}

function iterationRecordCore(
  iteration: number,
  subAgentSuffix: string,
  coderSummary: SubAgentTurnSummary,
  testerSummary: SubAgentTurnSummary,
  pendingPatchIdsAfterCoder: string[],
  newPendingPatchIds: string[],
  activePatchIdsForIteration: string[],
  stalePendingPatchIds: string[],
  testerVerdict: TesterVerdict,
  testerVerdictScope: CodingIterationRecord["testerVerdictScope"],
  revisionReasonCategory: import("./codingLoopTypes").RevisionReasonCategory,
  managerDecision: ManagerIterationDecision
): CodingIterationRecord {
  return {
    iteration,
    subAgentSuffix,
    coderSummary,
    testerSummary,
    pendingPatchIdsAfterCoder,
    newPendingPatchIds,
    activePatchIdsForIteration,
    stalePendingPatchIds: stalePendingPatchIds.length ? stalePendingPatchIds : undefined,
    testerVerdict,
    testerVerdictScope,
    revisionReasonCategory,
    managerDecision,
    loopDecision: legacyLoopDecision(managerDecision),
  };
}

function iterationRecordStub(
  iteration: number,
  subAgentSuffix: string,
  coderSummary: SubAgentTurnSummary,
  testerSummary: SubAgentTurnSummary,
  pendingPatchIdsAfterCoder: string[],
  newPendingPatchIds: string[],
  activePatchIdsForIteration: string[],
  stalePendingPatchIds: string[],
  testerVerdict: TesterVerdict,
  revisionReasonCategory: import("./codingLoopTypes").RevisionReasonCategory,
  managerDecision: ManagerIterationDecision
): CodingIterationRecord {
  return iterationRecordCore(
    iteration,
    subAgentSuffix,
    coderSummary,
    testerSummary,
    pendingPatchIdsAfterCoder,
    newPendingPatchIds,
    activePatchIdsForIteration,
    stalePendingPatchIds,
    testerVerdict,
    "patch_set",
    revisionReasonCategory,
    managerDecision
  );
}

function iterationRecordFailed(
  iteration: number,
  subAgentSuffix: string,
  coderSummary: SubAgentTurnSummary,
  testerSummary: SubAgentTurnSummary,
  pendingPatchIdsAfterCoder: string[],
  newPendingPatchIds: string[],
  activePatchIdsForIteration: string[],
  stalePendingPatchIds: string[],
  testerVerdict: TesterVerdict,
  revisionReasonCategory: import("./codingLoopTypes").RevisionReasonCategory,
  managerDecision: ManagerIterationDecision
): CodingIterationRecord {
  return iterationRecordCore(
    iteration,
    subAgentSuffix,
    coderSummary,
    testerSummary,
    pendingPatchIdsAfterCoder,
    newPendingPatchIds,
    activePatchIdsForIteration,
    stalePendingPatchIds,
    testerVerdict,
    "patch_set",
    revisionReasonCategory,
    managerDecision
  );
}

function finalize(
  status: CodingLoopTerminalStatus,
  iterations: CodingIterationRecord[],
  host: CodingCollaborationLoopHost,
  sharedProjectId: string,
  summaryForUser: string,
  terminalIterationHint?: number,
  blueprintContextAssembly?: CodingCollaborationLoopResult["blueprintContextAssembly"],
  subagentTurnAudit?: CodingSubagentTurnAuditEntry[]
): CodingCollaborationLoopResult {
  const last = iterations[iterations.length - 1];
  const terminalIterationIndex =
    terminalIterationHint ?? last?.iteration ?? iterations.length ?? 0;
  host.log("coding_loop.complete", {
    status,
    iterationCount: iterations.length,
    loopRunId: host.loopRunId,
    parentRequestId: host.parentRequestId,
  });
  return {
    status,
    loopRunId: host.loopRunId,
    parentRequestId: host.parentRequestId,
    sharedProjectId,
    iterations,
    summaryForUser,
    terminalIterationIndex,
    lastActivePatchIds: last?.activePatchIdsForIteration ?? [],
    ...(blueprintContextAssembly != null ? { blueprintContextAssembly } : {}),
    ...(subagentTurnAudit?.length ? { subagentTurnAudit } : {}),
  };
}
