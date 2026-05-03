export interface VoiceSessionOptions {
  sessionId: string;
  mode: "push-to-talk" | "hands-free";
}

export interface VoiceService {
  readonly enabled: boolean;
  startSession(options: VoiceSessionOptions): Promise<{ status: "disabled" | "placeholder"; sessionId: string }>;
  stopSession(sessionId: string): Promise<void>;
}

class PlaceholderVoiceService implements VoiceService {
  readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  async startSession(options: VoiceSessionOptions): Promise<{ status: "disabled" | "placeholder"; sessionId: string }> {
    if (!this.enabled) {
      return { status: "disabled", sessionId: options.sessionId };
    }

    return { status: "placeholder", sessionId: options.sessionId };
  }

  async stopSession(_sessionId: string): Promise<void> {
    // Placeholder for future transport teardown.
  }
}

export function createVoiceService(enabled: boolean): VoiceService {
  return new PlaceholderVoiceService(enabled);
}
