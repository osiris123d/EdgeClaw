# Cloudflare-Native Conversational Agent Prototype

A production-ready, serverless conversational task system on Cloudflare Workers.

This project processes operational tasks (incident triage, change review, analysis workflows) through a deterministic + AI-assisted pipeline with approval gates, structured logging, and persistent task history.

## Quick Demo

Run locally:

```powershell
npm install
npm run dev
```

Set an API key for local/prod requests (required for `/tasks` and `/api`):

```powershell
# local dev vars or wrangler secret in deployed env
# API_KEY=your-key
```

1. Health check (no auth):

```powershell
curl.exe -s "http://127.0.0.1:8787/health"
```

2. Create a task:

```powershell
curl.exe -s -X POST "http://127.0.0.1:8787/tasks" `
  -H "Content-Type: application/json" `
  -H "x-api-key: your-key" `
  -d '{"userId":"demo-user","input":{"objective":"Audit NAC policy change impact","payload":{"incidentId":"INC-1001"}}}'
```

3. Run task execution:

```powershell
curl.exe -s -X POST "http://127.0.0.1:8787/tasks/run-next" `
  -H "Content-Type: application/json" `
  -H "x-api-key: your-key" `
  -d '{"taskId":"<TASK_ID_FROM_STEP_2>"}'
```

4. Retrieve task results (includes worklog + final outputs when available):

```powershell
curl.exe -s "http://127.0.0.1:8787/tasks/<TASK_ID_FROM_STEP_2>" `
  -H "x-api-key: your-key"
```

## MVP Functionality (Works Today)

- Chat + API task intake through Cloudflare Worker routes
- Agent pipeline:
  - `DispatcherAgent` (classification + task creation)
  - `AnalystAgent` (analysis output)
  - `AuditAgent` (quality and approval verdict)
- `TaskWorkflow` orchestration with approval pause/resume
- `TaskCoordinatorDO` lease-based coordination per task
- R2 persistence:
  - task packets
  - workflow artifacts
  - worklogs
  - chat sessions/messages
- API key protection for all `/tasks` and `/api` routes
- `/health` route for fast readiness checks
- Structured production logging (agent role + event type + taskId when available)

## API Overview

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | No | Fast health probe (`{ ok: true, checks }`) |
| `GET` | `/chat` | No | Minimal web chat UI |
| `POST` | `/api/chat/sessions` | Yes | Create chat session |
| `GET` | `/api/chat/sessions/:sessionId/messages` | Yes | Fetch chat history |
| `POST` | `/api/chat/sessions/:sessionId/messages` | Yes | Stream assistant reply (SSE) |
| `POST` | `/tasks` | Yes | Create task packet |
| `POST` | `/tasks/run-next` | Yes | Execute task workflow |
| `GET` | `/tasks/:taskId` | Yes | Get task + worklog + optional final outputs |
| `GET` | `/tasks/:taskId/approval` | Yes | Get approval status/card payload |
| `POST` | `/tasks/:taskId/approve` | Yes | Approve paused task |
| `POST` | `/tasks/:taskId/reject` | Yes | Reject paused task |

Notes:
- Error shape is consistent for failures: `{ ok: false, error: string }`
- `POST /tasks/run-next` is idempotent for already-completed/in-progress/awaiting-approval tasks

## Architecture Overview (Current Code)

```text
HTTP Router (src/index.ts)
  -> DispatcherAgent (src/agents/DispatcherAgent.ts)
  -> TaskWorkflow (src/workflows/TaskWorkflow.ts)
      -> AnalystAgent (src/agents/AnalystAgent.ts)
      -> AuditAgent (src/agents/AuditAgent.ts)
      -> Approval gate
  -> TaskCoordinatorDO (src/durable/TaskCoordinatorDO.ts)
  -> R2_ARTIFACTS + R2_WORKLOGS (src/lib/r2.ts)
  -> Chat persistence/SSE (src/lib/chat.ts)
```

### Why Cloudflare (vs containers)

| Dimension | Cloudflare Workers + DO + R2 | Container Stack |
|---|---|---|
| Cold start | Very low | Higher baseline |
| Scale model | Automatic | Ops-managed replicas |
| Stateful coordination | Durable Objects | Extra infra (Redis/DB locks) |
| Deployment speed | `wrangler deploy` | Build/push/orchestrate |
| Cost floor | Low for MVP | Higher idle cost |

## Component List

### Core Modules (`src/lib/`)

| File | Purpose | Status |
|---|---|---|
| `chat.ts` | Chat session/message model and SSE helpers | Complete |
| `logger.ts` | Minimal structured production logger | Complete |
| `r2.ts` | R2 key model + task/worklog/artifact helpers | Complete |
| `approval.ts` | Approval record and response builders | Complete |
| `task-schema.ts` | Request validation/normalization for task creation | Complete |
| `types.ts` | Shared interfaces (`Env`, task and agent types) | Complete |

### Agents (`src/agents/`)

| File | Role |
|---|---|
| `DispatcherAgent.ts` | Inbound classification and task packet creation |
| `AnalystAgent.ts` | Deterministic + optional AI-assisted analysis |
| `AuditAgent.ts` | Deterministic + optional AI-assisted audit and verdict |

### Orchestration

| File | Responsibility |
|---|---|
| `TaskWorkflow.ts` | End-to-end step orchestration, approval pause/resume, finalization |
| `TaskCoordinatorDO.ts` | Per-task lease, step state, and workflow coordination |

## Setup & Local Development

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npx wrangler`)
- Cloudflare account (for deploy)

### Install and Run

```powershell
npm install
npm run build
npm run dev
```

### Local Auth/Env

Use `.dev.vars` (or equivalent local env injection):

```bash
ENVIRONMENT=development
LOG_LEVEL=debug
API_KEY=your-key
AI_GATEWAY_BASE_URL=
AI_GATEWAY_ROUTE_ANALYST=v1/analyze
AI_GATEWAY_ROUTE_CLASSIFIER=v1/classify
AUTO_START_WORKFLOW=false
```

### Quick Local Checks

```powershell
curl.exe -s "http://127.0.0.1:8787/health"
curl.exe -s -X POST "http://127.0.0.1:8787/tasks" -H "x-api-key: your-key" -H "Content-Type: application/json" -d '{"userId":"u1","input":{"objective":"Test","payload":{}}}'
```

## Deployment

Use the dedicated deployment runbook:

- `DEPLOYMENT.md`

High-level:

```powershell
npm run build
npx wrangler deploy --dry-run --env production
npx wrangler deploy --env production
```

### Production Verification

Run these checks immediately after deploy:

```powershell
curl.exe -s "https://<your-worker-url>/health"
curl.exe -s "https://<your-worker-url>/ready"
```

Core task flow:

```powershell
# 1) Create task
curl.exe -s -X POST "https://<your-worker-url>/tasks" `
  -H "Content-Type: application/json" `
  -H "x-api-key: <API_KEY>" `
  -d '{"userId":"prod-verify","input":{"objective":"Production verification","payload":{"check":"smoke"}}}'

# 2) Get task
curl.exe -s "https://<your-worker-url>/tasks/<TASK_ID>" `
  -H "x-api-key: <API_KEY>"

# 3) Run next
curl.exe -s -X POST "https://<your-worker-url>/tasks/run-next" `
  -H "Content-Type: application/json" `
  -H "x-api-key: <API_KEY>" `
  -d '{"taskId":"<TASK_ID>"}'
```

Success indicators: `/health` returns `{ "ok": true }`; `/ready` returns `ok: true`; `/tasks` returns `202` with `taskId`; `GET /tasks/:taskId` returns `200`; `/tasks/run-next` returns `200` (completed) or `202` (in progress / awaiting approval).

## Configuration & Secrets

### Required Bindings

- Durable Object: `TASK_COORDINATOR`
- R2 buckets: `R2_ARTIFACTS`, `R2_WORKLOGS`
- DO migration for `TaskCoordinatorDO` (tagged in `wrangler.toml`)

### Required/Recommended Vars

| Name | Required | Secret | Notes |
|---|---|---|---|
| `API_KEY` (or `MVP_API_KEY`) | Yes for protected routes | Yes | Validates `/tasks` + `/api` requests |
| `ENVIRONMENT` | Recommended | No | `development` or `production` |
| `LOG_LEVEL` | Recommended | No | Runtime log verbosity |
| `AI_GATEWAY_BASE_URL` | Optional | No | Leave empty for deterministic-only mode |
| `AI_GATEWAY_TOKEN` | Optional | Yes | Needed only for AI-assisted calls |
| `AI_GATEWAY_ROUTE_ANALYST` | Optional | No | Default route for analyst calls |
| `AI_GATEWAY_ROUTE_CLASSIFIER` | Optional | No | Dispatcher classifier route |
| `AUTO_START_WORKFLOW` | Optional | No | `false` recommended for MVP safety |

Set secrets:

```powershell
npx wrangler secret put API_KEY --env production
npx wrangler secret put AI_GATEWAY_TOKEN --env production
```

## Observability & Debugging

### Structured Logs

Production logs are JSON events with minimal cardinality, including:

- `event`: `start | complete | error`
- `agentRole`: `dispatcher | analyst | audit`
- `taskId`: included when available

Example:

```json
{"ts":"2026-04-01T21:05:12.552Z","level":"error","event":"error","agentRole":"audit","taskId":"...","message":"Audit failed","data":{"error":"..."}}
```

### Error Handling Contract

- Unhandled route exceptions return sanitized:

```json
{"ok":false,"error":"Internal server error."}
```

- Internal details are logged server-side only.

## Detailed Task Flow

1. User submits task (`POST /tasks`) or task-like chat message.
2. Dispatcher classifies task type/domain and persists TaskPacket.
3. `POST /tasks/run-next` runs workflow:
   - load task
   - analyst step
   - audit step
   - approval gate
   - finalize
4. If audit requires review, workflow pauses and creates ApprovalRecord.
5. Reviewer calls `/tasks/:taskId/approve` or `/tasks/:taskId/reject`.
6. Final output artifact is persisted and returned by `GET /tasks/:taskId` when available.

## Future Roadmap (Not Implemented Yet)

### Phase 2: Browser Rendering Integration

Planned:
- evidence capture from internal tools
- screenshot/table extraction task types
- extra approval policy for sensitive targets

### Phase 3: Dynamic Worker Execution

Planned:
- isolated execution for custom validations/transforms
- strict timeout and policy guardrails

### Phase 4: External Chat Adapters

Planned:
- Teams/Discord/Matrix/Webex webhook adapters
- platform signature validation and replay protection

### Phase 5: Enterprise Connectors

Planned:
- ServiceNow, Okta, SAML, incident tooling integrations
- cross-system ticket correlation and role-based approval policies

## Contributing & Extending

### Add a New Agent

1. Add agent class under `src/agents/`
2. Wire orchestration step in `src/workflows/TaskWorkflow.ts`
3. Add route/integration entrypoint if needed
4. Add tests in `tests/`

### Add a New Adapter

1. Add normalized adapter model in `src/lib/`
2. Add webhook route in `src/index.ts`
3. Add signature verification and replay protection

## License

Create a LICENSE file for this project using MIT license.
Include my name as the author.

Built with Cloudflare Workers, Durable Objects, R2, and TypeScript.
