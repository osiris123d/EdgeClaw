import type { SharedWorkspaceGateway } from "../../../workspace/sharedWorkspaceTypes";
import type { CodingCollaborationLoopHost } from "../codingLoopTypes";
import type { DelegationOptions, SubAgentResult } from "../../delegation";

/** Parses iteration index from suffix `${loopRunId}-i${n}` produced by the coding loop. */
export function parseIterationFromOptions(options: DelegationOptions | undefined): number {
  const suffix = options?.subAgentInstanceSuffix ?? "";
  const m = /-i(\d+)$/.exec(suffix);
  return m ? parseInt(m[1], 10) : 1;
}

export interface ScriptedCoderTurn {
  /** When false, delegateToCoder returns ok:false without mutating patches. Default true. */
  ok?: boolean;
  /**
   * Optional: simulate coder tool calls that violate gateway policy (e.g. writes outside `staging/`).
   * Errors are appended to the returned coder text; does not add patches by itself.
   */
  illegalCoderWrites?: ReadonlyArray<{ relativePath: string; content?: string }>;
  /** Patch proposals created via gateway after a successful coder turn (simulates shared_workspace_put_patch). */
  addPatches?: ReadonlyArray<{ patchId: string; body?: string }>;
}

export interface ScriptedTesterTurn {
  ok?: boolean;
  verdict: "pass" | "fail" | "unknown";
  /**
   * Deterministic body before VERDICT line (FAIL/PASS). Repeated failures should reuse the same string
   * to exercise repeated-failure guardrails.
   */
  preamble?: string;
}

export interface ScriptedIteration {
  coder: ScriptedCoderTurn;
  tester: ScriptedTesterTurn;
}

export type ScriptedLoopIterations = Readonly<Partial<Record<number, ScriptedIteration>>>;

function defaultCoderTurn(): ScriptedCoderTurn {
  return { ok: true, addPatches: [] };
}

function buildTesterText(tester: ScriptedTesterTurn): string {
  if (tester.verdict === "unknown") {
    return tester.preamble ?? "Ambiguous outcome — cannot decide.";
  }
  const preamble = tester.preamble ?? "Automated review.";
  const line = tester.verdict === "pass" ? "VERDICT: PASS" : "VERDICT: FAIL";
  return `${preamble}\n${line}`;
}

/**
 * Deterministic fake {@link CodingCollaborationLoopHost}: coder adds scripted patches; tester returns scripted verdict text.
 * Does not touch MainAgent or network.
 */
export function createScriptedCodingCollaborationLoopHost(options: {
  loopRunId: string;
  parentRequestId: string;
  sharedProjectId: string;
  gateway: SharedWorkspaceGateway;
  /** 1-based iteration index → scripted coder/tester behavior. Missing keys throw. */
  iterations: ScriptedLoopIterations;
  /** Optional capture for assertions / debugging */
  logSink?: string[];
}): CodingCollaborationLoopHost {
  const { loopRunId, parentRequestId, sharedProjectId, gateway, iterations, logSink } = options;

  function requireIteration(iteration: number): ScriptedIteration {
    const row = iterations[iteration];
    if (!row) {
      throw new Error(`scriptedCodingLoopHost: missing iteration ${iteration} in iterations map`);
    }
    return row;
  }

  return {
    loopRunId,
    parentRequestId,

    async delegateToCoder(_message: string, opts: DelegationOptions): Promise<SubAgentResult> {
      void _message;
      const iteration = parseIterationFromOptions(opts);
      const row = requireIteration(iteration);
      const coder = { ...defaultCoderTurn(), ...row.coder };
      if (coder.ok === false) {
        return { ok: false, text: "", events: [], error: "scripted coder failure" };
      }
      const coderNotes: string[] = [];
      for (const iw of coder.illegalCoderWrites ?? []) {
        const content = iw.content ?? "x";
        const fw = await gateway.writeFile("coder", sharedProjectId, iw.relativePath, content);
        if ("error" in fw) {
          coderNotes.push(`gateway_block:${iw.relativePath}=${fw.error}`);
        } else {
          coderNotes.push(`unexpected_ok:${iw.relativePath}`);
        }
      }
      for (const p of coder.addPatches ?? []) {
        const body = p.body ?? "--- simulated patch ---\n";
        const put = await gateway.putPatchProposal("coder", sharedProjectId, p.patchId, body);
        if ("error" in put) {
          return { ok: false, text: "", events: [], error: put.error };
        }
      }
      const base = coderNotes.length ? coderNotes.join("\n") : "(scripted coder)";
      return { ok: true, text: base, events: [] };
    },

    async delegateToTester(_message: string, opts: DelegationOptions): Promise<SubAgentResult> {
      void _message;
      const iteration = parseIterationFromOptions(opts);
      const row = requireIteration(iteration);
      const tester = row.tester;
      if (tester.ok === false) {
        return { ok: false, text: "", events: [], error: "scripted tester failure" };
      }
      const text = buildTesterText(tester);
      return { ok: true, text, events: [] };
    },

    getOrchestratorGateway(): SharedWorkspaceGateway {
      return gateway;
    },

    log(event: string, data: Record<string, unknown>): void {
      void logSink?.push(`${event} ${JSON.stringify(data)}`);
      void event;
      void data;
    },
  };
}
