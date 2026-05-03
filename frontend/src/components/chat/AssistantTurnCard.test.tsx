import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";

import { AssistantTurnCard } from "./AssistantTurnCard";
import type { AssistantTurn } from "../../types";

afterEach(cleanup);

function buildTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    kind: "assistant-turn",
    id: "turn-1",
    role: "assistant",
    status: "done",
    reasoningSummary: [],
    activitySteps: [],
    content: "Completed response.",
    toolsUsed: [],
    isStreaming: false,
    ui: {
      reasoningExpanded: false,
      activityExpanded: false,
      userToggledReasoning: false,
      userToggledActivity: false,
    },
    ...overrides,
  };
}

describe("AssistantTurnCard browser artifact rendering", () => {
  it("browser enabled + no tool call => no screenshot claim", () => {
    render(
      <AssistantTurnCard
        turn={buildTurn()}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    expect(screen.queryByText("Screenshot preview")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Browser run completed, but no screenshot artifact was returned.")
    ).not.toBeInTheDocument();
  });

  it("browser enabled + tool returns screenshot => inline image renders in timeline", () => {
    const turn = buildTurn({
      toolsUsed: ["browser_execute"],
      activitySteps: [
        {
          id: "browser-step",
          label: "browser_execute",
          status: "completed",
          toolName: "browser_execute",
          toolResult: {
            schema: "edgeclaw.browser-tool-result",
            schemaVersion: 1,
            toolName: "browser_execute",
            pageUrl: "https://example.com",
            description: "Homepage screenshot",
            artifact: {
              kind: "image",
              url: "https://cdn.example.com/screenshot.png",
              mimeType: "image/png",
              width: 1280,
              height: 720,
            },
          },
        },
      ],
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onResumeBrowserSession={() => {}}
      />
    );

    expect(screen.getByText("Screenshot preview")).toBeInTheDocument();
    expect(screen.getByText("Source URL: https://example.com")).toBeInTheDocument();
    expect(screen.getByText("Homepage screenshot")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Homepage screenshot" })).toHaveAttribute(
      "src",
      "https://cdn.example.com/screenshot.png"
    );
  });

  it("browser enabled + tool returns no image => inline warning state renders", () => {
    const turn = buildTurn({
      toolsUsed: ["browser_execute"],
      activitySteps: [
        {
          id: "browser-step",
          label: "browser_execute",
          status: "completed",
          toolName: "browser_execute",
          toolResult: {
            schema: "edgeclaw.browser-tool-result",
            schemaVersion: 1,
            toolName: "browser_execute",
            pageUrl: "https://example.com",
            rawOutputText: "Captured title only.",
            metadata: { title: "Example Domain" },
            artifact: null,
          },
        },
      ],
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onResumeBrowserSession={() => {}}
      />
    );

    expect(
      screen.getByText("Browser run completed, but no screenshot artifact was returned.")
    ).toBeInTheDocument();
    expect(screen.getAllByText("Source URL: https://example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("Raw tool metadata")).toBeInTheDocument();
  });

  it("client renders image from _screenshotDataUrl when available", () => {
    const screenshotDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const turn = buildTurn({
      toolsUsed: ["browser_execute"],
      activitySteps: [
        {
          id: "browser-step",
          label: "browser_execute",
          status: "completed",
          toolName: "browser_execute",
          toolResult: {
            schema: "edgeclaw.browser-tool-result",
            schemaVersion: 1,
            toolName: "browser_execute",
            pageUrl: "https://example.com",
            description: "Screenshot from normalized data URL",
            _screenshotDataUrl: screenshotDataUrl,
            artifact: null,
            metadata: { title: "Example" },
          },
        },
      ],
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    // Verify the screenshot is rendered from _screenshotDataUrl
    const allImgs = screen.getAllByRole("img");
    const screenshotImg = allImgs.find(
      (img) => img.getAttribute("alt") === "Screenshot from normalized data URL"
    );
    expect(screenshotImg).toBeDefined();
    expect(screenshotImg).toHaveAttribute("src", screenshotDataUrl);
  });

  it("client does not display _screenshotDataUrl in visible text", () => {
    const screenshotDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const turn = buildTurn({
      toolsUsed: ["browser_execute"],
      activitySteps: [
        {
          id: "browser-step-nodisplay",
          label: "browser_execute",
          status: "completed",
          toolName: "browser_execute",
          toolResult: {
            schema: "edgeclaw.browser-tool-result",
            schemaVersion: 1,
            toolName: "browser_execute",
            _screenshotDataUrl: screenshotDataUrl,
            artifact: null,
          },
        },
      ],
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    // Verify screenshot renders with data URL
    const allImgs = screen.getAllByRole("img");
    expect(allImgs.length).toBeGreaterThan(0);
    const hasDataUrlImg = allImgs.some((img) =>
      (img.getAttribute("src") ?? "").startsWith("data:image/png;base64,")
    );
    expect(hasDataUrlImg).toBe(true);

    // Verify raw base64 string is not visible as text
    expect(screen.queryByText(/iVBORw0KGgo/)).not.toBeInTheDocument();
  });

  it("fallback to artifact.url when _screenshotDataUrl not available", () => {
    const turn = buildTurn({
      toolsUsed: ["browser_execute"],
      activitySteps: [
        {
          id: "browser-step-fallback",
          label: "browser_execute",
          status: "completed",
          toolName: "browser_execute",
          toolResult: {
            schema: "edgeclaw.browser-tool-result",
            schemaVersion: 1,
            toolName: "browser_execute",
            pageUrl: "https://example.com",
            description: "Fallback artifact URL",
            artifact: {
              kind: "image",
              url: "https://cdn.example.com/screenshot-fallback-test.png",
              mimeType: "image/png",
              width: 1280,
              height: 720,
            },
          },
        },
      ],
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    // Verify artifact URL is rendered as image source
    const artifactImg = screen.getByRole("img", {
      name: "Fallback artifact URL",
    });
    expect(artifactImg).toHaveAttribute(
      "src",
      "https://cdn.example.com/screenshot-fallback-test.png"
    );
  });

  it("client renders image from top-level screenshot (plain base64 live shape)", () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const turn = buildTurn({
      toolsUsed: ["browser_execute"],
      activitySteps: [
        {
          id: "browser-step-raw-screenshot",
          label: "browser_execute",
          status: "completed",
          toolName: "browser_execute",
          toolResult: {
            schema: "edgeclaw.browser-tool-result",
            schemaVersion: 1,
            toolName: "browser_execute",
            pageUrl: "https://example.com",
            description: "Live screenshot",
            // Simulate the live browser_execute payload shape: top-level screenshot = raw base64
            screenshot: base64,
            artifact: null,
          } as unknown as import("../../types").BrowserToolResult,
        },
      ],
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    // Image must be rendered from the reconstructed data URL
    const allImgs = screen.getAllByRole("img");
    const screenshotImg = allImgs.find((img) =>
      (img.getAttribute("src") ?? "").startsWith(`data:image/png;base64,${base64}`)
    );
    expect(screenshotImg).toBeDefined();
    // Raw base64 must not appear as visible text
    expect(screen.queryByText(/iVBORw0KGgo/)).not.toBeInTheDocument();
  });
});

describe("AssistantTurnCard browser session rendering", () => {
  const BASE64_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  function buildSessionTurn(
    sessionResult: import("../../types").BrowserSessionResult,
    extra: Partial<import("../../types").AssistantTurn> = {}
  ): import("../../types").AssistantTurn {
    return buildTurn({
      toolsUsed: ["browser_session"],
      activitySteps: [
        {
          id: "session-step-1",
          label: "browser_session",
          status: "completed",
          toolName: "browser_session",
          sessionResult,
        },
      ],
      ...extra,
    });
  }

  it("no browser_session steps => section renders nothing", () => {
    render(
      <AssistantTurnCard
        turn={buildTurn()}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );
    // No HITL prompt, no status badge
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/● REC/)).not.toBeInTheDocument();
  });

  it("active session with screenshot renders inline image and Open Live View button", () => {
    const dataUrl = `data:image/png;base64,${BASE64_1PX}`;
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-active-1",
      status: "active",
      recordingEnabled: false,
      liveViewUrl: "https://live.cloudflare.com/devtools?target=t-abc",
      devtoolsFrontendUrl: "devtools://devtools/bundled/inspector.html?targetId=t-abc",
      currentUrl: "https://example.com",
      _screenshotDataUrl: dataUrl,
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    // Inline image rendered from session screenshot
    const allImgs = screen.getAllByRole("img");
    const sessionImg = allImgs.find(
      (img) => (img.getAttribute("src") ?? "").startsWith("data:image/png;base64,")
    );
    expect(sessionImg).toBeDefined();

    // Open Live View primary action rendered
    expect(
      screen.getByRole("link", { name: /Open Live View/i })
    ).toHaveAttribute("href", "https://live.cloudflare.com/devtools?target=t-abc");
  });

  it("awaiting_human renders HITL alert and Open Live View button", () => {
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-hitl-1",
      status: "awaiting_human",
      recordingEnabled: true,
      reusableSessionId: "provider-hitl-1",
      needsHumanIntervention: true,
      resumableSession: {
        sessionId: "provider-hitl-1",
        liveViewUrl: "https://live.cloudflare.com/devtools?target=t-hitl",
        expiresAt: "2026-04-22T12:00:00.000Z",
      },
      _resumeBrowserAction: {
        operation: "resume_browser_session",
        sessionId: "sess-hitl-1",
      },
      liveViewUrl: "https://live.cloudflare.com/devtools?target=t-hitl",
      summary: "Session paused awaiting human input: Please solve the CAPTCHA.",
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onResumeBrowserSession={() => {}}
      />
    );

    // HITL alert must be visible
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/CAPTCHA|awaiting human|human input/i);
    expect(
      screen.getByRole("link", { name: /Open Live View/i })
    ).toHaveAttribute("href", "https://live.cloudflare.com/devtools?target=t-hitl");
    expect(screen.getAllByRole("button", { name: /Resume session/i }).length).toBeGreaterThan(0);
  });

  it("reusable session metadata renders reusable session panel and copy affordance", () => {
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-reusable-1",
      status: "active",
      recordingEnabled: true,
      reusableSessionId: "provider-reusable-1",
      browserRunSessionId: "provider-reusable-1",
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    expect(screen.getByText(/Reusable Session/i)).toBeInTheDocument();
    expect(screen.getByText(/provider-reusable-1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy session ID/i })).toBeInTheDocument();
  });

  it("recording-ready hint renders without fake download link when recordingUrl is absent", () => {
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-recording-ready",
      status: "completed",
      recordingEnabled: true,
      recordingReady: true,
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    expect(screen.getByText(/does not expose a downloadable recording URL yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open recording/i })).not.toBeInTheDocument();
  });

  it("no liveViewUrl means no Open Live View button", () => {
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-no-live-view",
      status: "active",
      recordingEnabled: true,
      devtoolsFrontendUrl: "devtools://devtools/bundled/inspector.html?targetId=fallback",
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: /Open Live View/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /DevTools/i })).toBeInTheDocument();
  });

  it("recordingEnabled=true renders REC badge", () => {
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-rec-1",
      status: "active",
      recordingEnabled: true,
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    expect(screen.getAllByText(/● REC/).length).toBeGreaterThan(0);
  });

  it("recordingEnabled=false does not render REC badge", () => {
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-norec-1",
      status: "active",
      recordingEnabled: false,
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    expect(screen.queryAllByText(/● REC/).length).toBe(0);
  });

  it("completed session renders completed status, no HITL alert", () => {
    const turn = buildSessionTurn({
      schema: "edgeclaw.browser-session-result",
      schemaVersion: 1,
      sessionId: "sess-done-1",
      status: "completed",
      recordingEnabled: false,
      summary: "Task finished successfully.",
    });

    render(
      <AssistantTurnCard
        turn={turn}
        onToggleReasoning={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0);
  });
});
