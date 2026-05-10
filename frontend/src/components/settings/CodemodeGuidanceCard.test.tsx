import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { FeatureSettings } from "../../types";
import { DEFAULT_AURA_TTS_SPEAKER } from "../../lib/auraTts";
import { CodemodeGuidanceCard } from "./CodemodeGuidanceCard";
import {
  DEFAULT_CODEMODE_GUIDANCE_NOTES,
  MAX_CODEMODE_GUIDANCE_CHARS,
} from "../../constants/codemodeGuidanceDefaults";

afterEach(cleanup);

function buildSettings(overrides: Partial<FeatureSettings> = {}): FeatureSettings {
  return {
    enableBrowserTools: false,
    enableCodeExecution: false,
    codemodeToolSurfaceEnabled: true,
    codemodeAutoFallbackToLegacyTools: true,
    enableMcp: false,
    enableVoice: false,
    observabilityLevel: "info",
    voiceMode: "disabled",
    ttsSpeaker: DEFAULT_AURA_TTS_SPEAKER,
    browserStepExecutor: "cdp",
    browsingInferenceBackend: "workers-ai",
    voiceFluxEotThreshold: 0.7,
    voiceFluxEotTimeoutMs: 5000,
    voiceFluxEagerEotThreshold: undefined,
    codemodeGuidanceEnabled: true,
    codemodeGuidanceNotes: DEFAULT_CODEMODE_GUIDANCE_NOTES,
    ...overrides,
  };
}

describe("CodemodeGuidanceCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows effective preview when showEffectivePreview is true", () => {
    const { container } = render(
      <CodemodeGuidanceCard
        settings={buildSettings()}
        onChangeSettings={vi.fn()}
        setField={vi.fn()}
        showEffectivePreview={true}
      />
    );
    expect(screen.getByText(/Effective guidance preview/i)).toBeInTheDocument();
    expect(screen.getByText(/dev \/ debug/i)).toBeInTheDocument();
    const pre = container.querySelector(".settings-codemode-guidance-effective-preview-body");
    expect(pre?.textContent).toMatch(/cloudflare-dex-health/i);
  });

  it("does not render dev preview toggle when showEffectivePreview is false", () => {
    render(
      <CodemodeGuidanceCard settings={buildSettings()} onChangeSettings={vi.fn()} setField={vi.fn()} />
    );
    expect(screen.queryByText(/Effective guidance preview/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /MCP \/ Codemode Guidance/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable guidance injection/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Guidance notes/i)).toBeInTheDocument();
  });

  it("Save clamps notes to MAX_CODEMODE_GUIDANCE_CHARS", () => {
    const setField = vi.fn();
    const filler = buildSettings({
      codemodeGuidanceNotes: "z".repeat(MAX_CODEMODE_GUIDANCE_CHARS + 42),
    });
    render(<CodemodeGuidanceCard settings={filler} onChangeSettings={vi.fn()} setField={setField} />);

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(setField.mock.calls.some((c) => c[0] === "codemodeGuidanceNotes")).toBe(true);
    const [, saved] =
      setField.mock.calls.find((c) => c[0] === "codemodeGuidanceNotes") ?? [];
    expect(typeof saved).toBe("string");
    expect((saved as string).length).toBeLessThanOrEqual(MAX_CODEMODE_GUIDANCE_CHARS);
  });

  it("Reset restores defaults via onChangeSettings", () => {
    const onChangeSettings = vi.fn();
    const settings = buildSettings({
      codemodeGuidanceEnabled: false,
      codemodeGuidanceNotes: "custom junk",
    });
    render(
      <CodemodeGuidanceCard settings={settings} onChangeSettings={onChangeSettings} setField={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Reset to defaults/i }));
    expect(onChangeSettings).toHaveBeenCalledTimes(1);
    const arg = onChangeSettings.mock.calls[0]![0] as FeatureSettings;
    expect(arg.codemodeGuidanceEnabled).toBe(true);
    expect(arg.codemodeGuidanceNotes).toBe(DEFAULT_CODEMODE_GUIDANCE_NOTES);
  });
});
