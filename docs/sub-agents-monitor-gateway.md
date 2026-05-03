# Sub-Agents monitor, session audit, and AI Gateway cost

## Worker secrets and vars

- **`CLOUDFLARE_API_TOKEN`** (secret): Cloudflare API token with permission to call **AI Gateway → List logs** for your account. Used only on the Worker for `GET /api/coordinator/ai-gateway/runs/:runId/logs`.
- **`CLOUDFLARE_ACCOUNT_ID`**: Account id. Can be a `vars` entry or omitted when it can be parsed from `AI_GATEWAY_BASE_URL` (`/v1/{account_id}/{gateway_id}/…`).
- **`AI_GATEWAY_BASE_URL`**: Must match the OpenAI-compat gateway URL (typically ends with `/openai/compat`). The account and gateway segments populate log queries when `AI_GATEWAY_ID` is unset.
- **`AI_GATEWAY_ID`** (optional var): Gateway slug if the base URL does not follow the default `/v1/{account}/{gateway}/` pattern.

Orchestration requests should continue to send **`cf-aig-metadata`** with a `run` key equal to the persisted control-plane **`runId`** so log filters match.

## Manual test checklist

1. **Sessions (Monitor → Sessions)**  
   With at least one stored run, open Sub-Agents → Monitor → Sessions. Expand a session: confirm nested runs, **View in Runs** switches to Runs and highlights the row, **Review** opens Monitor → Review when `taskId` is set.

2. **Runs → Cost / logs**  
   Select **Cost / logs** on a completed task-backed run. With API token and gateway targeting configured, expect a token/cost strip and a log table (or a clear 503 JSON error if not configured).

3. **`subagentTurnAudit`**  
   After a task-backed coding loop completes, reload runs (or re-open the page). Open **Cost / logs** for that run: the **Sub-agent turn audit** table should list coder/tester iterations with truncated previews when the backend persisted audit rows.

4. **KV / GET runs**  
   Confirm `subagentTurnAudit` appears on the run object returned from `GET /api/coordinator/runs` (or your usual control-plane read path) for newly finalized runs.
