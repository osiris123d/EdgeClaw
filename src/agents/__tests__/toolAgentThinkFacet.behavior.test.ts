import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolAgentResultEnvelope } from "../toolAgentResultEnvelope";

const here = dirname(fileURLToPath(import.meta.url));
const facetSrc = readFileSync(
  join(here, "..", "subagents", "ToolAgentThinkFacet.ts"),
  "utf8"
);
const codemodeSurfaceSrc = readFileSync(
  join(here, "..", "..", "tools", "codemodeMetaSurface.ts"),
  "utf8"
);

function shouldStopAfterSecondSemanticFailure(errorTexts: string[]): boolean {
  let semanticFailureCount = 0;
  let lastSemanticType: string | undefined;
  for (const errorText of errorTexts) {
    const env = buildToolAgentResultEnvelope({
      ok: false,
      errorText,
      hadToolActivity: true,
    });
    const currentType = env.failure?.type;
    if (currentType && currentType === lastSemanticType) {
      semanticFailureCount += 1;
    } else {
      semanticFailureCount = 1;
      lastSemanticType = currentType;
    }
    if (semanticFailureCount > 1) return true;
  }
  return false;
}

test("repeated semantic tool errors stop after the second failure, even if formatting differs", () => {
  const stop = shouldStopAfterSecondSemanticFailure([
    "TRUNCATED: Response exceeded context limit while listing records",
    "Truncated - response exceeded context limit!",
  ]);
  assert.equal(stop, true);
});

test("negative control: two genuinely different errors do not trigger repeated-error stop", () => {
  const stop = shouldStopAfterSecondSemanticFailure([
    "TRUNCATED: Response exceeded context limit while listing records",
    "multiple accounts found; please specify account_id parameter",
  ]);
  assert.equal(stop, false);
});

test("outer ok=true with nested result.ok=false is treated as failure path in ToolAgentThinkFacet source", () => {
  const src = readFileSync(join(here, "..", "subagents", "ToolAgentThinkFacet.ts"), "utf8");
  assert.match(src, /function hasNestedFailure\(/);
  assert.match(src, /if \(obj\.ok === false\) return true;/);
  assert.match(src, /if \(!inner\.ok \|\| hasNestedFailure\(inner\)\)/);
});

test("wrapper/helper required-input contract is enforced and direct native invocation guidance exists", () => {
  assert.match(facetSrc, /Before invoking a native MCP tool with `tools_call`, call `tools_describe`/);
  assert.match(facetSrc, /required parameters listed in descriptions must appear in `tools_call` `input`/);
  assert.match(facetSrc, /missing_required_tool_input/);
});

// ── Large result guard wiring (source-contract) ────────────────────────────────

test("large_result guard is imported and wired in ToolAgentThinkFacet", () => {
  assert.match(facetSrc, /buildLargeResultEnvelope/);
  assert.match(facetSrc, /MAX_FINAL_RESPONSE_CHARS/);
  assert.match(facetSrc, /applyReductionPipeline/);
});

test("reduction pipeline and transformation log markers exist in ToolAgentThinkFacet", () => {
  assert.match(facetSrc, /reduction_pipeline/);
  assert.match(facetSrc, /root_cause_semantic_failure detected/);
  assert.match(facetSrc, /applyReductionPipeline/);
});

test("soul prompt includes Rule 9 reduction-first execution", () => {
  assert.match(facetSrc, /Rule 9.*Reduction-first execution/);
  assert.match(facetSrc, /map\/filter\/reduce/);
  assert.match(facetSrc, /DO NOT return it directly/);
});

test("soul prompt includes Rule 10 codemode as primary transform", () => {
  assert.match(facetSrc, /Rule 10.*Codemode as primary transform/);
  assert.match(facetSrc, /Design codemode calls/);
});

test("soul prompt includes Rule 6 pagination discipline", () => {
  assert.match(facetSrc, /Rule 6.*Large result and pagination discipline/);
  assert.match(facetSrc, /paginated extraction mode/);
  assert.match(facetSrc, /scannedCount.*matchedCount.*artifactPointer/);
});

test("soul prompt includes Rule 7 no raw JSON dumps", () => {
  assert.match(facetSrc, /Rule 7.*No raw JSON dumps/);
});

test("soul prompt includes Rule 8 compact accumulator pattern", () => {
  assert.match(facetSrc, /Rule 8.*Compact accumulator pattern/);
  assert.match(facetSrc, /running compact accumulator/);
});

// ── clampSubAgentResultForRpc preserves new metadata fields (source-contract) ──

test("clampSubAgentResultForRpc preserves scannedCount, matchedCount, artifactPointer, suggestedRetryPrompt", () => {
  const delegationSrc = readFileSync(join(here, "..", "delegation.ts"), "utf8");
  assert.match(delegationSrc, /scannedCount.*toolAgentResultRaw\.scannedCount/s);
  assert.match(delegationSrc, /matchedCount.*toolAgentResultRaw\.matchedCount/s);
  assert.match(delegationSrc, /matched.*toolAgentResultRaw\.matched/s);
  assert.match(delegationSrc, /artifactPointer/);
  assert.match(delegationSrc, /suggestedRetryPrompt.*toolAgentResultRaw\.suggestedRetryPrompt/s);
});

// ── Determinism / failure determinism (source-contract) ──────────────────────

test("normalizeSemanticErrorKey and countSemanticKeyInSynthesis exist in ToolAgentThinkFacet", () => {
  assert.match(facetSrc, /function normalizeSemanticErrorKey\(/,
    "normalizeSemanticErrorKey() normalizes different error phrasings to canonical key");
  assert.match(facetSrc, /function countSemanticKeyInSynthesis\(/,
    "countSemanticKeyInSynthesis() counts repeated failures in synthesis text");
  assert.match(facetSrc, /missing_tool_input:account_id/,
    "canonical key for account_id missing input errors");
  assert.match(facetSrc, /wrong_tool_api:spec_not_defined/,
    "canonical key for wrong API / spec errors");
});

test("no_silent_success guard log marker exists in ToolAgentThinkFacet source", () => {
  assert.match(facetSrc, /no_silent_success/,
    "log marker for no-silent-success guard");
  assert.match(facetSrc, /hadToolActivity.*empty_resultText=true/,
    "no-silent-success guard includes context");
});

test("repeated semantic failure detection: repeated=true log marker exists in rpcCollectChatTurn", () => {
  assert.match(facetSrc, /repeated=\$\{repeatedSemanticFailure\}/,
    "logs whether the stop was triggered by repeated same-key failures");
  assert.match(facetSrc, /semanticKey=\$\{rootCauseKey/,
    "logs the normalized semantic key that triggered early stop");
  assert.match(facetSrc, /Repeated semantic failure.*stopped after 2 identical errors/,
    "descriptive reason when repeated semantic key stops exploration");
});

test("Guard 0 scans fullEvidenceCorpus including tool synthesis for root causes", () => {
  assert.match(facetSrc, /fullEvidenceCorpus/,
    "full evidence corpus aggregates error + result + synthesis");
  assert.match(facetSrc, /synthesisForGuard/,
    "tool synthesis used in root-cause detection");
  assert.match(facetSrc, /countSemanticKeyInSynthesis\(synthesisForGuard/,
    "synthesis text scanned for repeated semantic keys");
});

test("setup-surface failures are deterministic and stop before inference", () => {
  assert.match(
    facetSrc,
    /if \(this\._mcpMirrorSetupFailure\)[\s\S]*return clampSubAgentResultForRpc\(/,
    "rpcCollectChatTurn returns deterministic failure before running inference when setup failed"
  );
  assert.match(
    facetSrc,
    /tool_agent_setup_failure:codemode_surface_incomplete/,
    "incomplete wrapped search/execute surface is treated as setup failure"
  );
  assert.match(
    facetSrc,
    /throw new Error\(setupError\)/,
    "beforeTurn fails fast when codemode surface is incomplete"
  );
});

test("soul prompt includes Rule 11 minimal endpoint execution plan guidance", () => {
  assert.match(facetSrc, /Rule 11.*Minimal endpoint execution plan/);
  assert.match(facetSrc, /Endpoint discovery is not equivalent to endpoint execution/);
  assert.match(facetSrc, /Construct the smallest sufficient execution plan from the user’s requested fields/);
  assert.match(facetSrc, /Never call mutation endpoints unless the user explicitly requests mutation behavior/);
});

test("soul prompt enforces codemode cm initialization before helper usage", () => {
  assert.match(facetSrc, /Rule 14.*Codemode `cm` initialization is mandatory/);
  assert.match(
    facetSrc,
    /const cm = typeof codemode !== \\\"undefined\\\" \? codemode : arguments\[0\]\?\.codemode/,
    "ToolAgent instructions include canonical cm initialization preamble"
  );
  assert.match(facetSrc, /MUST initialize `cm` exactly once/);
  assert.match(
    facetSrc,
    /Do not call `cm\.openapi_search`, `cm\.openapi_describe_operation`, `cm\.cloudflare_request`, or any other `cm\.\*` helper before this initialization/,
  );
  assert.match(facetSrc, /Never assume `cm` already exists in scope/);
});

test("codemode surface description reinforces discovery-vs-execution planner rule", () => {
  assert.match(codemodeSurfaceSrc, /Endpoint discovery is not equivalent to endpoint execution/);
  assert.match(codemodeSurfaceSrc, /smallest sufficient execution plan/);
  assert.match(codemodeSurfaceSrc, /never use mutation endpoints unless the user explicitly requests mutation behavior/i);
});

test("codemode canonical snippet initializes cm before first cm helper call", () => {
  const initIndex = codemodeSurfaceSrc.indexOf("const cm = typeof codemode !==");
  assert.ok(initIndex >= 0, "canonical cm initialization snippet exists");
  const searchStart = initIndex + 1;
  const openapiSearchIndex = codemodeSurfaceSrc.indexOf("cm.openapi_search", searchStart);
  const openapiDescribeIndex = codemodeSurfaceSrc.indexOf(
    "cm.openapi_describe_operation",
    searchStart
  );
  const cloudflareRequestIndex = codemodeSurfaceSrc.indexOf(
    "cm.cloudflare_request",
    searchStart
  );

  assert.ok(openapiSearchIndex > initIndex, "cm.openapi_search appears after cm initialization");
  assert.ok(
    openapiDescribeIndex > openapiSearchIndex,
    "cm.openapi_describe_operation appears after cm.openapi_search"
  );
  assert.ok(
    cloudflareRequestIndex > openapiDescribeIndex,
    "cm.cloudflare_request appears after describe step"
  );
});

test("explicit OpenAPI chain contract is enforced with fallback transparency in ToolAgentThinkFacet", () => {
  assert.match(facetSrc, /requiresExplicitOpenApiChain\(/);
  assert.match(facetSrc, /hasExplicitOpenApiChainEvidence\(/);
  assert.match(facetSrc, /hasToolsCallCodeFallbackEvidence\(/);
  assert.match(facetSrc, /allowsExplicitOpenApiChainFallback\(/);
  assert.match(facetSrc, /tool_\[a-z0-9\]\+_execute/);
  assert.match(facetSrc, /Fallback attempted: tools_call_code/);
  assert.match(facetSrc, /expected\s*"\s*\+\s*"openapi_search -> openapi_describe_operation -> cloudflare_request/);
});

test("CHAIN-EVIDENCE: extractStrictChainEvidenceFromThread is defined and scans _chainEvidence from thread tool outputs", () => {
  assert.match(facetSrc, /function extractStrictChainEvidenceFromThread\(/,
    "extractStrictChainEvidenceFromThread must be defined");
  assert.match(facetSrc, /_chainEvidence/,
    "source must reference _chainEvidence marker field");
  assert.match(facetSrc, /tool.*openapi_search.*openapi_describe_operation.*cloudflare_request|openapi_search.*openapi_describe_operation.*cloudflare_request/s,
    "extraction function must handle all three chain tool names");
  assert.match(facetSrc, /interface StrictChainEvidenceItem/,
    "StrictChainEvidenceItem interface must be defined");
  assert.match(facetSrc, /interface StrictChainEvidence/,
    "StrictChainEvidence interface must be defined");
});

test("CHAIN-EVIDENCE: recursive walk function exists with depth limit 20", () => {
  assert.match(facetSrc, /function walkForChainEvidence\(/,
    "walkForChainEvidence must be defined");
  assert.match(facetSrc, /depth > 20/,
    "walkForChainEvidence must enforce depth limit of 20");
  assert.match(facetSrc, /STRICT_CHAIN_TOOL_NAMES/,
    "constant set of chain tool names must exist");
  assert.match(facetSrc, /const merged = \{ \.\.\.cev, \.\.\.existing \}/,
    "merge must not erase existing truthy/called fields (existing takes priority)");
  assert.match(facetSrc, /\[EdgeClaw\]\[strict-chain-evidence\]/,
    "structured log marker must be emitted");
  assert.match(facetSrc, /source.*recursive_tool_output/,
    "structured log must identify source as recursive_tool_output");
});

test("CHAIN-EVIDENCE: strict-chain validator prefers structured evidence and detects describe-cache failure", () => {
  assert.match(facetSrc, /hasStructuredChain/,
    "structured chain detection variable must exist");
  assert.match(facetSrc, /strictChainEvidence\.openapi_search\?\.called === true/,
    "must check openapi_search called in structured evidence");
  assert.match(facetSrc, /strictChainEvidence\.openapi_describe_operation\?\.called === true/,
    "must check openapi_describe_operation called in structured evidence");
  assert.match(facetSrc, /strictChainEvidence\.cloudflare_request\?\.called === true/,
    "must check cloudflare_request called in structured evidence");
  assert.match(facetSrc, /hasStructuredChain \|\| hasExplicitOpenApiChainEvidence/,
    "structured evidence must be OR-combined with text scan as fallback");
  assert.match(facetSrc, /isDescribeCacheFailure/,
    "describe/cache failure detection variable must exist");
  assert.match(facetSrc, /OpenAPI chain followed but describe\/cache failure/,
    "describe-cache failure must produce distinct error message not \"chain not followed\"");
});

test("CHAIN-EVIDENCE: missing helper still fails strict-chain validation (text fallback)", () => {
  // When no _chainEvidence is present in thread AND text scan also fails, chain is not satisfied.
  // This verifies the text-scan fallback is still required for legacy or unexpected paths.
  assert.match(facetSrc, /hasExplicitOpenApiChainEvidence\(chainEvidenceCorpus\)/,
    "text-scan fallback must still be invoked when structured evidence is absent");
  assert.match(facetSrc, /Detected missing chain evidence\./,
    "missing chain evidence error must still be emittable");
  assert.match(facetSrc, /Explicit OpenAPI chain was required but not followed/,
    "chain-not-followed error message must still exist");
});
