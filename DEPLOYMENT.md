# Deployment Guide

## Prerequisites

- Cloudflare account with Workers enabled
- `node` and `npm` installed
- Wrangler CLI access (`npx wrangler`)
- Project dependencies installed

```powershell
npm install
npx wrangler login
```

## Environment Setup

1. Confirm `wrangler.toml` has production env vars and bindings.
2. Create required R2 buckets (if not already created).
3. Create KV namespace and update `CACHE` id in `wrangler.toml`.

```powershell
npx wrangler r2 bucket create agent-artifacts-prod
npx wrangler r2 bucket create agent-worklogs-prod

```

## Authentication Model

Three distinct credentials are used in a production deployment. Do not confuse them.

| Credential | Secret name | Purpose | Who uses it |
|---|---|---|---|
| **EdgeClaw API key** | `API_KEY` | Authenticates inbound machine/API requests to the Worker (`/tasks`, `/config`, etc.) | CI systems, automation, machine clients |
| **AI Gateway token** | `AI_GATEWAY_TOKEN` | Authenticates EdgeClaw's outbound calls to Cloudflare AI Gateway | Worker only (server-side, never sent by end users) |
| **Cloudflare Access** | Managed in CF dashboard | Protects browser UI routes at the edge before the Worker runs | Browser users (zero-trust SSO) |

## Secrets Setup

Set production secrets (do not commit to repo):

```powershell
# EdgeClaw API key — used by machine clients for inbound API requests
npx wrangler secret put API_KEY --env production

# AI Gateway token — used by the Worker for outbound AI calls (not for inbound auth)
npx wrangler secret put AI_GATEWAY_TOKEN --env production
```

Optional fallback key name (supported by app as an alias for `API_KEY`):

```powershell
npx wrangler secret put MVP_API_KEY --env production
```

## Deploy Command

```powershell
npm run build
npx wrangler deploy --dry-run --env production
npx wrangler deploy --env production
```

## Verification Steps

1. Check deploy output URL from Wrangler.
2. Run health check.
3. Run authenticated task flow.

```powershell
curl.exe -s "https://<your-worker-url>/health"
```

Expected:

```json
{"ok":true,"checks":{"r2ArtifactsBound":true,"r2WorklogsBound":true,"taskCoordinatorBound":true}}
```

Create task:

```powershell
curl.exe -s -X POST "https://<your-worker-url>/tasks" `
  -H "Content-Type: application/json" `
  -H "x-api-key: <API_KEY>" `
  -d '{"userId":"prod-test","input":{"objective":"Test task","payload":{"incidentId":"INC-1"}}}'
```

Run task:

```powershell
curl.exe -s -X POST "https://<your-worker-url>/tasks/run-next" `
  -H "Content-Type: application/json" `
  -H "x-api-key: <API_KEY>" `
  -d '{"taskId":"<TASK_ID>"}'
```

Get task:

```powershell
curl.exe -s "https://<your-worker-url>/tasks/<TASK_ID>" `
  -H "x-api-key: <API_KEY>"
```

## Production Smoke Test

Run this minimal flow after deploy:

1. Create task (`POST /tasks`), capture `taskId`.
2. Read task (`GET /tasks/:taskId`), verify task exists and response is `ok: true`.
3. Execute workflow (`POST /tasks/run-next`) with the same `taskId`.
4. Read task again (`GET /tasks/:taskId`) to verify updated status and outputs.

Create task:

```powershell
curl.exe -s -X POST "https://<your-worker-url>/tasks" `
  -H "Content-Type: application/json" `
  -H "x-api-key: <API_KEY>" `
  -d '{"userId":"smoke-test","input":{"objective":"Production smoke test","payload":{"check":"deploy"}}}'
```

Get task:

```powershell
curl.exe -s "https://<your-worker-url>/tasks/<TASK_ID>" `
  -H "x-api-key: <API_KEY>"
```

Run next:

```powershell
curl.exe -s -X POST "https://<your-worker-url>/tasks/run-next" `
  -H "Content-Type: application/json" `
  -H "x-api-key: <API_KEY>" `
  -d '{"taskId":"<TASK_ID>"}'
```

Expected success indicators:

- `POST /tasks` returns `202` with `ok: true` and a `taskId`.
- `GET /tasks/:taskId` returns `200` with `ok: true` and task/worklog payload.
- `POST /tasks/run-next` returns `200` (`status: "completed"`) or `202` (`status: "awaiting_approval"` / `"in_progress"`).
- A second `POST /tasks/run-next` for completed tasks returns idempotent success (`status: "completed"`).

Note: deterministic fallback is acceptable if AI Gateway is unset; MVP execution should still succeed.

## Rollback Steps

1. Identify last known-good commit.
2. Checkout that commit.
3. Redeploy production.

```powershell
git checkout <known-good-commit>
npm run build
npx wrangler deploy --env production
```

Optional hardening:

- Keep a stable release tag for quick rollback.
- Rotate `API_KEY` secret if exposure is suspected.
