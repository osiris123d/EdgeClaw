# Sandbox orchestration micro-fixture

In-repo **non-production** scratch content for local experiments with the coding collaboration loop (`MainAgent` → coder → tester **orchestration contract**).

- **Logical project id** (in-memory only): see `SANDBOX_ORCHESTRATION_MICRO_PROJECT_ID` in `src/sandbox/orchestrationMicroFixture.ts`.
- **Do not** bind this id to real KV, deploy pipelines, or customer data.
- The harness seeds a tiny tree only inside `InMemorySharedWorkspaceStorage` for the fixture id.

Run the harness:

```bash
npm run sandbox:orchestration
```

**Worker (real CoderAgent / TesterAgent):** set `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true` (and optional `DEBUG_ORCHESTRATION_TOKEN`), run `wrangler dev`, then `GET` or `POST /api/debug/orchestrate?session=default&mode=success` — see `src/debug/` and `src/server.ts`.
