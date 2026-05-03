/**
 * Permission matrix — git & Wrangler class actions (documentation + future enforcement).
 *
 * | Capability              | MainAgent (orchestrator) | CoderAgent      | TesterAgent     |
 * |-------------------------|--------------------------|-----------------|-----------------|
 * | Shared workspace rw     | yes (policy)             | staging+propose | verify only     |
 * | Patch lifecycle approve | yes                      | no              | no              |
 * | Git status / diff live  | yes (via adapter)        | no              | no              |
 * | Branch/commit suggestions| yes                     | yes             | no              |
 * | Export patch text       | yes                      | yes             | read/summarize  |
 * | Wrangler preview deploy | yes (when adapter exists)| no default      | no              |
 * | Wrangler production     | yes + explicit approval  | **never** default | **never**     |
 *
 * Sub-agents must not receive deploy bindings or production API routes by default — inject via
 * MainAgent-only tools or approved Workflow steps.
 */
export const GIT_INTEGRATION_PERMISSION_SUMMARY = [
  "orchestrator: repo_git_status, repo_git_working_diff, export bundle, suggestions, Wrangler gates (future)",
  "coder: suggestions + export single patch from shared workspace; no live git; no deploy",
  "tester: summarize/validate patch text only; no deploy; no live git",
].join("\n");
