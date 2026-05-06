import { useEffect, useRef } from "react";
import type { CoordinatorMaterializeMappingPreset, CoordinatorMaterializePreviewResponse } from "../../lib/coordinatorControlPlaneApi";
import type { CoordinatorProject, CoordinatorTask } from "../../types/coordinatorControlPlane";
import type { PrimaryRunMode, ExecutionStopMode } from "./projectAutonomyQuery";
import {
  autonomyTimelineSummary,
  formatAutonomyStopReasonHuman,
  parseLastOrchestrationPayload,
  type ParsedProjectAutonomyResult,
} from "./parseOrchestrationPayload";

function projectDisplayName(p: CoordinatorProject): string {
  return p.projectName?.trim() || p.title?.trim() || "Untitled";
}

function readinessBadgeClass(r: CoordinatorProject["readiness"] | undefined): string {
  if (r === "ready") return "coord-badge coord-badge-ok";
  if (r === "incomplete") return "coord-badge coord-badge-warn";
  return "coord-badge";
}

function taskRunnable(t: CoordinatorTask): boolean {
  return t.status === "todo" || t.status === "in_progress" || t.status === "review";
}

export type OrchestrationPresetId = "run_normal" | "single_step" | "batch_three";

export interface OrchestrationConsoleTabProps {
  sessionId: string;
  wsEndpoint: string;
  storageAvailable: boolean;
  projects: CoordinatorProject[];
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  selectedProject: CoordinatorProject | null;
  tasks: CoordinatorTask[];
  selectedOrchestrationTaskId: string | null;
  setSelectedOrchestrationTaskId: (id: string | null) => void;
  primaryRunMode: PrimaryRunMode;
  setPrimaryRunMode: (m: PrimaryRunMode) => void;
  executionStopMode: ExecutionStopMode;
  setExecutionStopMode: (m: ExecutionStopMode) => void;
  autonomyBatchMaxSteps: number;
  setAutonomyBatchMaxSteps: (n: number) => void;
  debugToken: string;
  setDebugToken: (s: string) => void;
  debugBusy: boolean;
  debugChildStateless: boolean;
  setDebugChildStateless: (v: boolean) => void;
  debugNoSharedTools: boolean;
  setDebugNoSharedTools: (v: boolean) => void;
  debugAttachControlPlaneProject: boolean;
  setDebugAttachControlPlaneProject: (v: boolean) => void;
  orchCodingLoopMaxIterations: string;
  setOrchCodingLoopMaxIterations: (s: string) => void;
  orchestrateLaunchBlocked: boolean;
  orchestrateTaskBlocksLaunch: boolean;
  orchestrateAttachBlocked: boolean;
  projectAutonomyBlocked: boolean;
  rpcStatus: "idle" | "connecting" | "connected" | "disconnected";
  connectRpc: () => void;
  disconnectRpc: () => void;
  minimalChildStateless: boolean;
  setMinimalChildStateless: (v: boolean) => void;
  sharedWorkspaceKvPresent: boolean;
  finalizeAckHumanReview: boolean;
  setFinalizeAckHumanReview: (v: boolean) => void;
  finalizePersistManifest: boolean;
  setFinalizePersistManifest: (v: boolean) => void;
  finalizeBusy: boolean;
  finalizeResult: string | null;
  runFinalizeProject: () => void;
  materializeMappingPreset: CoordinatorMaterializeMappingPreset;
  setMaterializeMappingPreset: (p: CoordinatorMaterializeMappingPreset) => void;
  materializePreview: CoordinatorMaterializePreviewResponse | null;
  materializePreviewBusy: boolean;
  runMaterializePreview: () => void;
  materializeBusy: boolean;
  runMaterializeProjectZip: () => void;
  runMaterializeProjectJson: () => void;
  runDebugHttp: (path: "orchestrate" | "coordinator-chain" | "delegated-ping", mode?: "success" | "fail_revise") => void;
  runProjectAutonomyHttp: (maxSteps: number) => void;
  runRpcOrchestrate: () => void;
  runRpcProbe: (which: "a" | "b1" | "c" | "ping") => void;
  debugResult: string | null;
  applyOrchestrationPreset: (id: OrchestrationPresetId) => void;
}

function autonomyBadgeClass(parsed: ParsedProjectAutonomyResult): string {
  const sr = (parsed.stopReason ?? "").toLowerCase();
  if (sr.includes("follow_up")) return "orch-result-badge orch-result-followups";
  if (sr.includes("blocked") || sr.includes("failure") || sr.includes("abort")) return "orch-result-badge orch-result-blocked";
  if (sr.includes("review")) return "orch-result-badge orch-result-review";
  if (sr.includes("error") || sr.includes("not_found")) return "orch-result-badge orch-result-error";
  if (sr.includes("complete") || sr.includes("candidate")) return "orch-result-badge orch-result-success";
  return "orch-result-badge orch-result-neutral";
}

function autonomyBadgeLabel(parsed: ParsedProjectAutonomyResult): string {
  const sr = (parsed.stopReason ?? "").toLowerCase();
  if (sr.includes("follow_up")) return "Follow-ups created";
  if (sr.includes("blocked") || sr.includes("failure")) return "Blocked";
  if (sr.includes("review")) return "Review";
  if (sr.includes("error") || sr.includes("not_found")) return "Error";
  if (sr.includes("max_steps_reached")) {
    const stepOk = parsed.steps.some((s) => /success|pass|complete/i.test(s.loopTerminalStatus ?? ""));
    const stepBad = parsed.steps.some((s) => /fail|block/i.test(s.loopTerminalStatus ?? ""));
    if (stepOk && !stepBad) return "Success · batch limit reached";
    return "Batch limit reached";
  }
  if (sr.includes("complete") || sr.includes("candidate")) return "Success";
  if (parsed.steps.some((s) => /fail|block/i.test(s.loopTerminalStatus ?? ""))) return "Blocked";
  if (parsed.steps.some((s) => /success|pass/i.test(s.loopTerminalStatus ?? ""))) return "Success";
  return "Finished";
}

export function OrchestrationConsoleTab(props: OrchestrationConsoleTabProps) {
  const parsed = parseLastOrchestrationPayload(props.debugResult);
  const parsedAutonomy = parsed?.kind === "project_autonomy" ? parsed : null;

  const finalizeBlocked =
    props.finalizeBusy ||
    !props.storageAvailable ||
    !props.sharedWorkspaceKvPresent ||
    !props.selectedProjectId ||
    !props.finalizeAckHumanReview;

  const materializeBlocked =
    props.materializeBusy ||
    props.materializePreviewBusy ||
    !props.storageAvailable ||
    !props.sharedWorkspaceKvPresent ||
    !props.selectedProjectId;

  const effectiveMaxStepsForBatch =
    props.executionStopMode === "single_step" ? 1 : Math.min(3, Math.max(1, props.autonomyBatchMaxSteps));

  const resultsPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const text = props.debugResult?.trim();
    if (!text) return;
    const el = resultsPanelRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    el.classList.add("orch-results-highlight");
    const timer = window.setTimeout(() => el.classList.remove("orch-results-highlight"), 2400);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove("orch-results-highlight");
    };
  }, [props.debugResult]);

  return (
    <div className="coord-section-stack orch-console">
      <section className="coord-panel orch-run-panel">
        <h3 className="coord-panel-title">Run task</h3>
        <div className="orch-flow-strip" aria-hidden>
          <span>Coder</span>
          <span className="orch-flow-arrow">→</span>
          <span>Tester</span>
          <span className="orch-flow-arrow">→</span>
          <span>Verdict</span>
          <span className="orch-flow-arrow">→</span>
          <span>Apply</span>
          <span className="orch-flow-arrow">→</span>
          <span>Follow-ups</span>
        </div>
        <p className="muted orch-run-desc">
          Execute tasks using agent orchestration (Coder → Tester → Verdict → Apply → Follow-ups).
        </p>

        <div className="orch-run-grid">
          <label className="orch-field">
            <span className="orch-field-label">Project</span>
            <select
              value={props.selectedProjectId ?? ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                props.setSelectedProjectId(v || null);
              }}
              disabled={props.debugBusy || !props.storageAvailable || props.projects.length === 0}
            >
              {props.projects.length === 0 ? (
                <option value="">— No projects —</option>
              ) : (
                props.projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {projectDisplayName(p)} ({p.readiness})
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="orch-field">
            <span className="orch-field-label">Task (optional)</span>
            <select
              value={props.selectedOrchestrationTaskId ?? ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                props.setSelectedOrchestrationTaskId(v ? v : null);
              }}
              disabled={props.debugBusy || !props.storageAvailable || !props.selectedProject}
            >
              <option value="">Auto — next runnable task</option>
              {props.tasks.map((t) => (
                <option key={t.taskId} value={t.taskId}>
                  {t.title} ({t.status}
                  {taskRunnable(t) ? "" : " — not runnable"})
                </option>
              ))}
            </select>
          </label>

          <label className="orch-field">
            <span className="orch-field-label">Mode</span>
            <select
              value={props.primaryRunMode}
              onChange={(e) => props.setPrimaryRunMode(e.target.value as PrimaryRunMode)}
              disabled={props.debugBusy}
            >
              <option value="success">Success</option>
              <option value="fail_revise">Fail/revise (debug)</option>
            </select>
          </label>

          <label className="orch-field orch-field-narrow">
            <span className="orch-field-label">Run N tasks (batch)</span>
            <input
              type="number"
              min={1}
              max={3}
              step={1}
              value={props.autonomyBatchMaxSteps}
              onChange={(e) => props.setAutonomyBatchMaxSteps(Math.min(3, Math.max(1, Number(e.target.value) || 1)))}
              disabled={props.debugBusy || props.executionStopMode === "single_step"}
              title="maxSteps for bounded project autonomy (1–3)"
            />
          </label>
        </div>

        {props.selectedProject ? (
          <p className="small muted orch-project-readiness">
            Readiness{" "}
            <span className={readinessBadgeClass(props.selectedProject.readiness)}>{props.selectedProject.readiness}</span>
            {props.projectAutonomyBlocked ? (
              <span className="coord-badge coord-badge-warn" style={{ marginLeft: 8 }}>
                Autonomy requires ready project
              </span>
            ) : null}
          </p>
        ) : (
          <p className="small muted">Select a project from the registry (or create one under Projects &amp; tasks).</p>
        )}

        <div className="orch-preset-row">
          <span className="orch-preset-label">Quick presets:</span>
          <button type="button" className="btn-header-secondary" disabled={props.debugBusy} onClick={() => props.applyOrchestrationPreset("run_normal")}>
            Run normally
          </button>
          <button type="button" className="btn-header-secondary" disabled={props.debugBusy} onClick={() => props.applyOrchestrationPreset("single_step")}>
            Single step
          </button>
          <button type="button" className="btn-header-secondary" disabled={props.debugBusy} onClick={() => props.applyOrchestrationPreset("batch_three")}>
            Run up to 3 tasks
          </button>
        </div>

        <div className="orch-primary-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={props.debugBusy || props.projectAutonomyBlocked || !props.storageAvailable}
            title={
              props.projectAutonomyBlocked
                ? "Pick a ready project."
                : !props.storageAvailable
                  ? "Control-plane KV required."
                  : undefined
            }
            onClick={() => void props.runProjectAutonomyHttp(1)}
          >
            {props.debugBusy ? "Running…" : "Run next task"}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={props.debugBusy || props.projectAutonomyBlocked || !props.storageAvailable}
            onClick={() => void props.runProjectAutonomyHttp(effectiveMaxStepsForBatch)}
          >
            {props.debugBusy ? "Running…" : `Run ${effectiveMaxStepsForBatch} task${effectiveMaxStepsForBatch === 1 ? "" : "s"}`}
          </button>
        </div>

        <details className="orch-finalize-details coord-panel" style={{ marginTop: 12 }}>
          <summary className="orch-finalize-summary">Finalize project (promotion prep)</summary>
          <div className="orch-finalize-body">
            <p className="muted small">
              Runs when all registry tasks are <strong>done</strong>, with no <code>needs_revision</code> /{" "}
              <code>blocked</code> review flags. Collects <strong>applied</strong> patches (excludes{" "}
              <code>debug-orch*</code>), compares touched file paths to blueprint docs (
              <code>PROJECT_SPEC.md</code>, <code>ROADMAP.md</code>, …), and returns a JSON manifest. Does{" "}
              <strong>not</strong> deploy.
            </p>
            {!props.sharedWorkspaceKvPresent ? (
              <p className="small muted">
                Shared workspace KV is not configured — bind <code>SHARED_WORKSPACE_KV</code> to read patches.
              </p>
            ) : null}
            <label className="orch-check orch-check-stack">
              <span className="orch-check-inline">
                <input
                  type="checkbox"
                  checked={props.finalizeAckHumanReview}
                  onChange={(e) => props.setFinalizeAckHumanReview(e.target.checked)}
                  disabled={props.finalizeBusy}
                />
                <span>I understand this is review-only and requires human approval before any real promotion.</span>
              </span>
            </label>
            <label className="orch-check">
              <input
                type="checkbox"
                checked={props.finalizePersistManifest}
                onChange={(e) => props.setFinalizePersistManifest(e.target.checked)}
                disabled={props.finalizeBusy}
              />{" "}
              Persist manifest JSON under <code>finalize/manifests/</code> in the shared workspace
            </label>
            <button
              type="button"
              className="btn-header-secondary"
              disabled={finalizeBlocked}
              title={
                finalizeBlocked && !props.finalizeAckHumanReview
                  ? "Confirm human review checkbox first."
                  : !props.sharedWorkspaceKvPresent
                    ? "Shared workspace KV required."
                    : undefined
              }
              onClick={() => void props.runFinalizeProject()}
            >
              {props.finalizeBusy ? "Finalizing…" : "Finalize project"}
            </button>
            {props.finalizeResult?.trim() ? (
              <details className="orch-raw-json" style={{ marginTop: 8 }}>
                <summary>Last finalize response</summary>
                <pre className="debug-orch-pre coord-json-pre" tabIndex={0}>
                  {props.finalizeResult}
                </pre>
              </details>
            ) : null}
          </div>
        </details>

        <details className="orch-finalize-details coord-panel" style={{ marginTop: 12 }}>
          <summary className="orch-finalize-summary">Materialize project (export files)</summary>
          <div className="orch-finalize-body">
            <p className="muted small">
              Replays <strong>applied</strong> shared-workspace patches in chronological order (same exclusions as finalize:
              skips <code>debug-orch*</code>). Parses unified diffs with <code>diff</code>&apos;s{" "}
              <code>parsePatch</code>/<code>applyPatch</code>, maintaining one buffer per logical path. Writes a ZIP you
              can unpack locally — the Worker cannot push files into an arbitrary folder on your machine (browser sandbox).
              Optional Git branch export is deferred.
            </p>
            <p className="muted small" style={{ marginTop: 8 }}>
              Path mapping presets replay staging prefixes into repo layout; authoritative placement intent for agents lives in
              the control-plane blueprint doc <code>FILE_STRUCTURE.md</code> (materialization does not infer structure from that
              doc automatically — operators choose the preset explicitly).
            </p>
            {!props.sharedWorkspaceKvPresent ? (
              <p className="small muted">
                Shared workspace KV is not configured — bind <code>SHARED_WORKSPACE_KV</code> to read patches.
              </p>
            ) : null}
            <fieldset className="orch-materialize-presets" style={{ border: "none", padding: 0, margin: "8px 0 0" }}>
              <legend className="small muted" style={{ padding: 0 }}>
                Path mapping for export
              </legend>
              <label className="orch-check orch-check-stack">
                <span className="orch-check-inline">
                  <input
                    type="radio"
                    name="materializeMappingPreset"
                    checked={props.materializeMappingPreset === "none"}
                    onChange={() => props.setMaterializeMappingPreset("none")}
                    disabled={props.materializeBusy || props.materializePreviewBusy}
                  />
                  <span>
                    <strong>No mapping</strong> — use paths exactly as they appear in patches (e.g.{" "}
                    <code>staging/...</code> stays under staging).
                  </span>
                </span>
              </label>
              <label className="orch-check orch-check-stack">
                <span className="orch-check-inline">
                  <input
                    type="radio"
                    name="materializeMappingPreset"
                    checked={props.materializeMappingPreset === "simple_staging"}
                    onChange={() => props.setMaterializeMappingPreset("simple_staging")}
                    disabled={props.materializeBusy || props.materializePreviewBusy}
                  />
                  <span>
                    <strong>Simple staging/</strong> → entire prefix <code>staging/</code> rewrites to <code>db/</code>.
                  </span>
                </span>
              </label>
              <label className="orch-check orch-check-stack">
                <span className="orch-check-inline">
                  <input
                    type="radio"
                    name="materializeMappingPreset"
                    checked={props.materializeMappingPreset === "team_task_tracker"}
                    onChange={() => props.setMaterializeMappingPreset("team_task_tracker")}
                    disabled={props.materializeBusy || props.materializePreviewBusy}
                  />
                  <span>
                    <strong>Team Task Tracker</strong> — maps schema, shared types, API routes/components/pages into repo
                    layout (<code>db/</code>, <code>src/</code>, <code>frontend/src/</code>).
                  </span>
                </span>
              </label>
            </fieldset>
            <div className="orch-primary-actions" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn-header-secondary"
                disabled={materializeBlocked}
                title={
                  materializeBlocked && !props.selectedProjectId ? "Select a project first." : undefined
                }
                onClick={() => void props.runMaterializePreview()}
              >
                {props.materializePreviewBusy ? "Loading preview…" : "Refresh path preview"}
              </button>
            </div>
            {props.materializePreview !== null ? (
              <div className="coord-table-wrap orch-materialize-preview-wrap" style={{ marginTop: 12 }}>
                {props.materializePreview.previewRows.length === 0 ? (
                  <p className="muted small">
                    Preview loaded — no path rows (often means no <strong>applied</strong> patches for this project).
                  </p>
                ) : (
                  <table className="coord-table orch-materialize-preview-table">
                    <thead>
                      <tr>
                        <th scope="col">Source path</th>
                        <th scope="col">Destination path</th>
                        <th scope="col">Patch id</th>
                        <th scope="col">Status</th>
                        <th scope="col">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.materializePreview.previewRows.map((row, i) => (
                        <tr key={`${row.patchId}-${i}-${row.destinationPath}`}>
                          <td>
                            <code>{row.sourcePath}</code>
                          </td>
                          <td>
                            <code>{row.destinationPath}</code>
                          </td>
                          <td>
                            <code>{row.patchId}</code>
                          </td>
                          <td>
                            <span
                              className={
                                row.status === "applied"
                                  ? "coord-badge coord-badge-ok"
                                  : row.status === "conflict"
                                    ? "coord-badge coord-badge-warn"
                                    : "coord-badge"
                              }
                            >
                              {row.status}
                            </span>
                          </td>
                          <td className="muted small">{row.detail ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="muted small" style={{ marginTop: 8 }}>
                  Preset in preview: <code>{props.materializePreview.mapping.preset}</code> · patches considered:{" "}
                  <strong>{props.materializePreview.patchCount}</strong> · materialized files:{" "}
                  <strong>{props.materializePreview.fileCount}</strong>
                </p>
              </div>
            ) : props.selectedProjectId ? (
              <p className="muted small" style={{ marginTop: 10 }}>
                Choose a mapping mode and click <strong>Refresh path preview</strong> before exporting (recommended).
              </p>
            ) : null}
            <div className="orch-primary-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn-primary"
                disabled={materializeBlocked}
                title={materializeBlocked ? "Pick a project and ensure shared workspace KV is bound." : undefined}
                onClick={() => void props.runMaterializeProjectZip()}
              >
                {props.materializeBusy ? "Exporting…" : "Materialize project (ZIP)"}
              </button>
              <button
                type="button"
                className="btn-header-secondary"
                disabled={materializeBlocked}
                onClick={() => void props.runMaterializeProjectJson()}
              >
                Export JSON
              </button>
            </div>
          </div>
        </details>
      </section>

      <section
        ref={resultsPanelRef}
        className={`coord-panel orch-results-panel${props.debugResult ? " orch-results-panel-active" : ""}`}
        aria-live="polite"
        aria-relevant="additions text"
      >
        <h3 className="coord-panel-title">Run results</h3>
        {!props.debugResult ? (
          <>
            <p className="muted small">Run a task to see stop reason, steps, and timeline here.</p>
            <p className="muted small orch-results-cta">
              Choose a project, then run the next task to see progress here.
            </p>
          </>
        ) : parsedAutonomy ? (
          <>
            <div className="orch-result-head">
              <span className={autonomyBadgeClass(parsedAutonomy)}>{autonomyBadgeLabel(parsedAutonomy)}</span>
              <span className="muted small">
                Batch iterations: <strong>{parsedAutonomy.stepsExecuted ?? "—"}</strong>
                {parsedAutonomy.maxStepsRequested != null ? (
                  <> / limit <strong>{parsedAutonomy.maxStepsRequested}</strong></>
                ) : null}
                {" · "}
                <span
                  title={
                    parsedAutonomy.stopReason
                      ? `stopReason (API): ${parsedAutonomy.stopReason}`
                      : undefined
                  }
                >
                  {formatAutonomyStopReasonHuman(parsedAutonomy)}
                </span>
              </span>
            </div>
            <p className="orch-timeline" aria-label="Run timeline">
              {autonomyTimelineSummary(parsedAutonomy)}
            </p>
            <p className="small muted">
              Primary task in this batch:{" "}
              <code>{parsedAutonomy.steps[0]?.taskId ?? props.selectedOrchestrationTaskId ?? "auto"}</code>
              {parsedAutonomy.steps.length > 1 ? ` (+${parsedAutonomy.steps.length - 1} more in batch)` : null}
            </p>
          </>
        ) : parsed?.kind === "generic_orchestrate" ? (
          <>
            <div className="orch-result-head">
              <span className="orch-result-badge orch-result-neutral">{parsed.status ?? "response"}</span>
            </div>
            {parsed.summaryForUser ? (
              <p className="small muted">{parsed.summaryForUser.slice(0, 400)}</p>
            ) : null}
          </>
        ) : (
          <p className="muted small">Response captured — open Raw JSON for detail.</p>
        )}
        {props.debugResult ? (
          <details className="orch-raw-json">
            <summary>Raw JSON response</summary>
            <pre className="debug-orch-pre coord-json-pre" tabIndex={0}>
              {props.debugResult}
            </pre>
          </details>
        ) : null}
      </section>

      <details className="coord-panel orch-settings-details">
        <summary className="orch-settings-summary">Advanced execution settings</summary>
        <div className="orch-settings-body">
          <p className="muted small orch-settings-lede">
            Token, stop behavior, and probe attachment — expand Debug overrides only when troubleshooting.
          </p>
          <label className="orch-field orch-field-full">
            <span className="orch-field-label">Worker orchestration token (optional)</span>
            <input
              type="password"
              autoComplete="off"
              placeholder="DEBUG_ORCHESTRATION_TOKEN when Worker requires Bearer auth"
              value={props.debugToken}
              onChange={(e) => props.setDebugToken(e.target.value)}
              disabled={props.debugBusy}
              className="debug-orch-token-input"
            />
          </label>

          <label className="orch-field orch-field-full">
            <span className="orch-field-label">Execution mode</span>
            <select
              value={props.executionStopMode}
              onChange={(e) => props.setExecutionStopMode(e.target.value as ExecutionStopMode)}
              disabled={props.debugBusy}
            >
              <option value="completion">Run until completion</option>
              <option value="review">Stop on review</option>
              <option value="failure">Stop on failure</option>
              <option value="single_step">Stop after 1 step</option>
            </select>
          </label>

          <label className="orch-check">
            <input
              type="checkbox"
              checked={props.debugAttachControlPlaneProject}
              onChange={(e) => props.setDebugAttachControlPlaneProject(e.target.checked)}
              disabled={props.debugBusy || !props.storageAvailable}
            />{" "}
            Attach registry blueprint for HTTP / RPC orchestrate probes (requires <strong>ready</strong> project)
          </label>
          {props.orchestrateAttachBlocked ? (
            <p className="small muted">Orchestrate probes disabled until project is ready or attachment is off.</p>
          ) : null}
          {props.orchestrateTaskBlocksLaunch ? (
            <p className="small muted">
              Pick a runnable task (todo / in_progress / review) or choose Auto for project-only orchestrate probes.
            </p>
          ) : null}

          <label className="orch-check">
            <input
              type="checkbox"
              checked={props.debugNoSharedTools}
              onChange={(e) => props.setDebugNoSharedTools(e.target.checked)}
              disabled={props.debugBusy}
            />{" "}
            Omit shared workspace tools on delegation
          </label>

          <details className="orch-debug-overrides-details">
            <summary className="orch-debug-overrides-summary">Debug overrides</summary>
            <div className="orch-debug-overrides-body">
              <p className="muted small orch-debug-overrides-warning">
                Dangerous or niche Worker flags — leave off unless you are diagnosing a specific issue.
              </p>
              <label className="orch-check orch-check-stack">
                <span className="orch-check-inline">
                  <input
                    type="checkbox"
                    checked={props.debugChildStateless}
                    onChange={(e) => props.setDebugChildStateless(e.target.checked)}
                    disabled={props.debugBusy}
                  />
                  <span>Use stateless child turn (advanced/debug only)</span>
                </span>
                <span className="muted small orch-check-hint">
                  Uses <code>rpcCollectStatelessModelTurn</code> — easy to misconfigure; prefer leaving off.
                </span>
              </label>
              <label className="orch-field orch-field-full">
                <span className="orch-field-label">Coding-loop max iterations (optional)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="omit for server default"
                  value={props.orchCodingLoopMaxIterations}
                  onChange={(e) => props.setOrchCodingLoopMaxIterations(e.target.value)}
                  disabled={props.debugBusy}
                />
              </label>
            </div>
          </details>
        </div>
      </details>

      <details className="coord-panel orch-diagnostics-details">
        <summary className="orch-diagnostics-summary">🔧 Diagnostics</summary>
        <div className="orch-diagnostics-body">
          <p className="muted small">
            HTTP orchestrate sandbox, coordinator chain, delegated ping, and Agent RPC probes. Same gates as production
            orchestration routes.
          </p>

          <div className="coord-debug-actions">
            <button
              type="button"
              className="btn-header-secondary"
              disabled={props.debugBusy || props.orchestrateLaunchBlocked}
              title={
                props.orchestrateLaunchBlocked
                  ? props.orchestrateTaskBlocksLaunch
                    ? "Pick a runnable task or Auto."
                    : "Ready project required when blueprint attach is on."
                  : undefined
              }
              onClick={() => void props.runDebugHttp("orchestrate")}
            >
              HTTP orchestrate
            </button>
            <button
              type="button"
              className="btn-header-secondary"
              disabled={props.debugBusy || props.orchestrateLaunchBlocked}
              onClick={() => void props.runDebugHttp("orchestrate", "fail_revise")}
            >
              HTTP fail_revise
            </button>
            <button type="button" className="btn-header-secondary" disabled={props.debugBusy} onClick={() => void props.runDebugHttp("coordinator-chain")}>
              Coordinator chain
            </button>
            <button type="button" className="btn-header-secondary" disabled={props.debugBusy} onClick={() => void props.runDebugHttp("delegated-ping")}>
              Delegated ping
            </button>
          </div>

          <p className="muted small">
            Repro HTTP: <code>/api/repro/subagent/agent-ping?session={props.sessionId}</code>,{" "}
            <code>think-chat</code> (<code>ENABLE_SUBAGENT_REPRO_ENDPOINT</code>).
          </p>

          <h4 className="orch-diagnostics-subtitle">Agent RPC</h4>
          <p className="muted small">
            WebSocket <code>{props.wsEndpoint}</code> — session aligns with Chat when ids match.
          </p>
          <div className="coord-debug-actions">
            {props.rpcStatus !== "connected" ? (
              <button type="button" className="btn-primary" onClick={props.connectRpc}>
                Connect for RPC
              </button>
            ) : (
              <button type="button" className="btn-header-secondary" onClick={props.disconnectRpc}>
                Disconnect
              </button>
            )}
            <span className={`coord-rpc-pill coord-rpc-${props.rpcStatus}`}>RPC: {props.rpcStatus}</span>
          </div>
          <div className="coord-debug-actions">
            <button
              type="button"
              className="btn-header-secondary"
              disabled={props.debugBusy || props.rpcStatus !== "connected" || props.orchestrateLaunchBlocked}
              onClick={() => void props.runRpcOrchestrate()}
            >
              RPC orchestrate
            </button>
            <button type="button" className="btn-header-secondary" disabled={props.debugBusy || props.rpcStatus !== "connected"} onClick={() => void props.runRpcProbe("a")}>
              A: Baseline child.chat
            </button>
            <button type="button" className="btn-header-secondary" disabled={props.debugBusy || props.rpcStatus !== "connected"} onClick={() => void props.runRpcProbe("b1")}>
              B1: Smoke delegateToCoder
            </button>
            <button type="button" className="btn-header-secondary" disabled={props.debugBusy || props.rpcStatus !== "connected"} onClick={() => void props.runRpcProbe("c")}>
              C: Minimal delegateTo
            </button>
            <label className="coord-inline-label coord-rpc-c-flag">
              <input
                type="checkbox"
                checked={props.minimalChildStateless}
                onChange={(e) => props.setMinimalChildStateless(e.target.checked)}
                disabled={props.debugBusy}
              />{" "}
              C stateless
            </label>
            <button type="button" className="btn-header-secondary" disabled={props.debugBusy || props.rpcStatus !== "connected"} onClick={() => void props.runRpcProbe("ping")}>
              Delegated rpcPing
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
