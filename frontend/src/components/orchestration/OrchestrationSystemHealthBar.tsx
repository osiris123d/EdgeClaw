import type { ReactNode } from "react";
import type { CoordinatorHealthResponse } from "../../lib/coordinatorControlPlaneApi";

type SlotHealth = "healthy" | "degraded" | "error";

function bindingHealth(ok: boolean | undefined): SlotHealth {
  if (ok === true) return "healthy";
  return "error";
}

function slotFromBool(ok: boolean | undefined): SlotHealth {
  if (ok === true) return "healthy";
  return "degraded";
}

interface OrchestrationSystemHealthBarProps {
  health: CoordinatorHealthResponse | null;
  healthLoading: boolean;
  onRefresh: () => void;
}

export function OrchestrationSystemHealthBar({
  health,
  healthLoading,
  onRefresh,
}: OrchestrationSystemHealthBarProps) {
  if (healthLoading && !health) {
    return (
      <div className="coord-stats-bar orch-health-bar" aria-label="Orchestration system health">
        <div className="coord-stats-skeleton muted">Loading health…</div>
      </div>
    );
  }
  if (!health) {
    return (
      <div className="coord-stats-bar orch-health-bar" aria-label="Orchestration system health">
        <div className="coord-stats-skeleton muted orch-health-slot orch-health-error">
          <strong>Error</strong> — health unavailable
        </div>
      </div>
    );
  }

  const slots: Array<{
    key: string;
    label: string;
    state: SlotHealth;
    detail: ReactNode;
  }> = [
    {
      key: "coord",
      label: "Coordinator binding",
      state: bindingHealth(health.subagentCoordinatorBindingPresent),
      detail: (
        <p className="muted small" style={{ marginTop: 8 }}>
          Subagent coordinator durable object binding. Required for Coder → Tester delegation on Workers.
        </p>
      ),
    },
    {
      key: "orch",
      label: "Orchestration HTTP",
      state: slotFromBool(health.debugOrchestrationEndpointEnabled),
      detail: (
        <p className="muted small" style={{ marginTop: 8 }}>
          <code>ENABLE_DEBUG_ORCHESTRATION_ENDPOINT</code> — gates task-backed orchestration HTTP routes.
        </p>
      ),
    },
    {
      key: "sw",
      label: "Shared workspace KV",
      state: slotFromBool(health.sharedWorkspaceKvPresent),
      detail: (
        <p className="muted small" style={{ marginTop: 8 }}>
          Patch staging and approvals for orchestration loops.
        </p>
      ),
    },
    {
      key: "cp",
      label: "Control-plane KV",
      state: slotFromBool(health.controlPlaneKvPresent),
      detail: (
        <p className="muted small" style={{ marginTop: 8 }}>
          Project registry, tasks, and run history used by this console.
        </p>
      ),
    },
  ];

  return (
    <div className="coord-stats-bar orch-health-bar" aria-label="Orchestration system health">
      {slots.map((s) => (
        <details key={s.key} className={`orch-health-card orch-health-${s.state}`}>
          <summary className="orch-health-summary">
            <span className="orch-health-label">{s.label}</span>
            <span className={`orch-health-pill orch-health-pill-${s.state}`}>
              {s.state === "healthy" ? "Healthy" : s.state === "error" ? "Error" : "Degraded"}
            </span>
          </summary>
          <div className="orch-health-body">{s.detail}</div>
        </details>
      ))}
      <details className="orch-health-card orch-health-healthy">
        <summary className="orch-health-summary">
          <span className="orch-health-label">Environment</span>
          <span className="orch-health-pill orch-health-pill-healthy">Healthy</span>
        </summary>
        <div className="orch-health-body">
          <dl className="coord-dl orch-health-dl">
            <dt>Name</dt>
            <dd>{health.environmentName}</dd>
            <dt>Debug Bearer configured</dt>
            <dd>{health.debugOrchestrationTokenConfigured ? "Yes" : "No"}</dd>
            <dt>Promotion artifact branch</dt>
            <dd>{health.promotionArtifactWriterBranch}</dd>
          </dl>
        </div>
      </details>
      <div className="orch-health-refresh">
        <button type="button" className="btn-header-secondary" onClick={() => void onRefresh()}>
          {healthLoading ? "Refreshing…" : "Refresh health"}
        </button>
      </div>
    </div>
  );
}
