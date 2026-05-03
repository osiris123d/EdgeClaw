import type {
  FlagshipEvaluationAdapter,
  FlagshipEvaluationContext,
  ReleaseGateAuditReason,
  ReleaseGateDecision,
  ReleaseGateOutcome,
  ReleaseTier,
} from "./flagshipTypes";

/**
 * HTTP outbound Flagship adapter — **compatibility / fallback** path when Workers `FLAGS` binding is unused.
 * **Canonical** release-gate evaluation on Workers uses {@link createBindingFlagshipEvaluationAdapter} (`flagshipEvaluationAdapterFactory.ts`).
 */

export interface HttpFlagshipEvaluationAdapterOptions {
  /** Full URL for POST (e.g. https://policy.example.com/v1/release-gate/evaluate). */
  evaluationUrl: string;
  /** When set, sends `Authorization: Bearer <token>`. */
  bearerToken?: string;
  fetchFn?: typeof fetch;
  /** Defaults to 15s. */
  timeoutMs?: number;
}

function isOutcome(x: unknown): x is ReleaseGateOutcome {
  return x === "allow" || x === "deny" || x === "hold";
}

function isTier(x: unknown): x is ReleaseTier {
  return x === "preview" || x === "canary" || x === "production";
}

function parseReasons(raw: unknown): ReleaseGateAuditReason[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: ReleaseGateAuditReason[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      return null;
    }
    const o = r as Record<string, unknown>;
    if (typeof o.code !== "string" || typeof o.message !== "string") {
      return null;
    }
    let detail: Readonly<Record<string, string>> | undefined;
    if (o.detail !== undefined) {
      if (!o.detail || typeof o.detail !== "object" || Array.isArray(o.detail)) {
        return null;
      }
      const d = o.detail as Record<string, unknown>;
      const entries: Record<string, string> = {};
      for (const [k, v] of Object.entries(d)) {
        if (typeof v !== "string") {
          return null;
        }
        entries[k] = v;
      }
      detail = entries;
    }
    out.push({ code: o.code, message: o.message, detail });
  }
  return out;
}

/**
 * Parses JSON body from a Flagship-compatible HTTP policy service.
 * Expected shape: `{ outcome, tier?, allowed?, reasons[] }`.
 */
export function parseFlagshipHttpReleaseDecision(
  json: unknown,
  fallbackTier: ReleaseTier
): ReleaseGateDecision | null {
  if (!json || typeof json !== "object") {
    return null;
  }
  const o = json as Record<string, unknown>;
  if (!isOutcome(o.outcome)) {
    return null;
  }
  const outcome = o.outcome;
  let reasons = parseReasons(o.reasons);
  if (!reasons) {
    return null;
  }
  if (reasons.length === 0 && outcome === "allow") {
    reasons = [
      {
        code: "FLAGSHIP_ALLOW",
        message: "Policy returned allow without structured reasons.",
      },
    ];
  }
  if (reasons.length === 0) {
    return null;
  }
  const tier = isTier(o.tier) ? o.tier : fallbackTier;
  const allowed = typeof o.allowed === "boolean" ? o.allowed : outcome === "allow";
  return {
    outcome,
    allowed,
    tier,
    reasons,
  };
}

function denyHttp(
  tier: ReleaseTier,
  code: string,
  message: string
): ReleaseGateDecision {
  return {
    outcome: "deny",
    allowed: false,
    tier,
    reasons: [{ code, message }],
  };
}

/**
 * POSTs {@link FlagshipEvaluationContext} as JSON to `evaluationUrl` and maps the response to {@link ReleaseGateDecision}.
 *
 * **Contract:** Response JSON must include `outcome` and `reasons` (except allow may omit reasons — a placeholder reason is injected).
 * HTTP/network failures produce **deny** with `FLAGSHIP_HTTP_ERROR` (fail-closed).
 */
export function createHttpFlagshipEvaluationAdapter(
  options: HttpFlagshipEvaluationAdapterOptions
): FlagshipEvaluationAdapter {
  const {
    evaluationUrl,
    bearerToken,
    fetchFn = globalThis.fetch.bind(globalThis),
    timeoutMs = 15_000,
  } = options;

  return {
    async evaluate(context: FlagshipEvaluationContext): Promise<ReleaseGateDecision> {
      const tier = context.tier;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (bearerToken?.trim()) {
        headers.Authorization = `Bearer ${bearerToken.trim()}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetchFn(evaluationUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(context),
          signal: controller.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return denyHttp(tier, "FLAGSHIP_HTTP_ERROR", `Flagship HTTP request failed: ${msg}`);
      } finally {
        clearTimeout(timer);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return denyHttp(
          tier,
          "FLAGSHIP_HTTP_ERROR",
          `Flagship HTTP response was not JSON (status ${res.status})`
        );
      }

      if (!res.ok) {
        const parsed = parseFlagshipHttpReleaseDecision(body, tier);
        if (parsed) {
          return parsed;
        }
        return denyHttp(
          tier,
          "FLAGSHIP_HTTP_ERROR",
          `Flagship HTTP status ${res.status} without parseable release decision`
        );
      }

      const parsed = parseFlagshipHttpReleaseDecision(body, tier);
      if (!parsed) {
        return denyHttp(tier, "FLAGSHIP_INVALID_RESPONSE", "Flagship HTTP JSON did not match ReleaseGateDecision shape");
      }
      return parsed;
    },
  };
}
