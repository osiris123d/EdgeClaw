import type { AssistantTurn } from "../../types";
import { AssistantAnswerBody } from "./AssistantAnswerBody";
import { ApprovalInlineCard } from "./ApprovalInlineCard";
import { BrowserArtifactInlineSection } from "./BrowserArtifactInlineSection";
import { BrowserSessionInlineSection } from "./BrowserSessionInlineSection";
import { AssistantReasoningPanel } from "./AssistantReasoningPanel";
import { TurnStatusHeader } from "./TurnStatusHeader";

interface AssistantTurnCardProps {
  turn: AssistantTurn;
  onToggleReasoning: (id: string) => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onResumeBrowserSession?: (sessionId: string) => void;
  /** When MCP is enabled, failed steps may show an inline re-auth callout. */
  enableMcp?: boolean;
  onOpenMcpSettings?: () => void;
  onRetryMcpLastUser?: () => void;
}

function formatDurationMs(startedAt?: number, completedAt?: number): string | null {
  if (!startedAt || !completedAt) return null;
  return `${((completedAt - startedAt) / 1000).toFixed(1)}s`;
}

export function AssistantTurnCard({
  turn,
  onToggleReasoning,
  onApprove,
  onDeny,
  onResumeBrowserSession,
  enableMcp = false,
  onOpenMcpSettings,
  onRetryMcpLastUser,
}: AssistantTurnCardProps) {
  const duration = formatDurationMs(turn.startedAt, turn.completedAt);

  return (
    <article className={`assistant-turn-card status-${turn.status}`} aria-label="Assistant turn">
      <TurnStatusHeader
        turnId={turn.id}
        status={turn.status}
        isStreaming={turn.isStreaming}
        isApprovalPending={Boolean(turn.approvalRequest)}
      />

      <AssistantReasoningPanel
        turn={turn}
        expanded={turn.ui.reasoningExpanded || turn.ui.activityExpanded}
        onToggle={() => onToggleReasoning(turn.id)}
        enableMcp={enableMcp}
        onOpenMcpSettings={onOpenMcpSettings}
        onRetryMcpLastUser={onRetryMcpLastUser}
      />

      {turn.approvalRequest && (
        <ApprovalInlineCard
          request={turn.approvalRequest}
          onApprove={() => onApprove(turn.id)}
          onDeny={() => onDeny(turn.id)}
        />
      )}

      {turn.error && <div className="assistant-turn-error">{turn.error}</div>}

      <AssistantAnswerBody content={turn.content} isStreaming={turn.isStreaming} startedAt={turn.startedAt} />

      <BrowserSessionInlineSection
        steps={turn.activitySteps}
        onResumeBrowserSession={onResumeBrowserSession}
      />

      <BrowserArtifactInlineSection steps={turn.activitySteps} />

      {(turn.toolsUsed.length > 0 || duration) && (
        <footer className="assistant-turn-footer">
          {turn.toolsUsed.length > 0 && <span>Tools used: {turn.toolsUsed.join(", ")}</span>}
          {duration && <span>Duration: {duration}</span>}
        </footer>
      )}
    </article>
  );
}
