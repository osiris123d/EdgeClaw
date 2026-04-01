# Cloudflare Resources & Bindings Reference

## Overview

This document details all Cloudflare resources required to deploy the agent prototype, including how to provision them and configure their bindings.

---

## 1. Durable Objects

### TaskCoordinator

**Purpose:** Coordinates active agent tasks, maintains state, prevents duplicate execution.

**Class:** `TaskCoordinator` (located in `src/durable-objects/task-coordinator.ts`)

**Binding Name:** `TASK_COORDINATOR`

**Setup:**

1. In `wrangler.toml`, add to `[durable_objects.bindings]`:
   ```toml
   [[durable_objects.bindings]]
   name = "TASK_COORDINATOR"
   class_name = "TaskCoordinator"
   script_name = "cloudflare-agent"
   environment = "production"
   ```

2. The class is auto-registered on first deployment to production.

**Methods Exposed:**

| Method | Purpose |
|--------|---------|
| `registerTask(taskId, requestId, userId)` | Create new task |
| `updateTask(taskId, updates)` | Update task state |
| `getTask(taskId)` | Fetch task by ID |
| `getUserTasks(userId)` | List all tasks for user |
| `completeTask(taskId, result)` | Mark task complete |
| `failTask(taskId, errorCode, errorMessage)` | Mark task failed |
| `acquireTaskLock(taskId)` | Get exclusive lock on task |

**State Storage:**

- Persists to Durable Object storage
- Auto-snapshots state every 5 seconds (Cloudflare default)
- Old completed tasks can be cleaned up with `cleanup(olderThanMs)`

---

### WorkLog (Future Phase 3)

**Purpose:** Historical task execution logs (currently stored in R2).

**Class:** `WorkLog`

**Binding Name:** `WORK_LOG`

**Status:** Not yet implemented (Phase 3). For now, worklog entries are stored in R2.

---

## 2. R2 Buckets

### agent-artifacts-prod

**Purpose:** Store generated outputs, reports, analysis results.

**Create:**

```bash
wrangler r2 bucket create agent-artifacts-prod --location eu
```

**Binding Name:** `R2_ARTIFACTS`

**Binding in wrangler.toml:**

```toml
[[r2_buckets]]
binding = "R2_ARTIFACTS"
bucket_name = "agent-artifacts-prod"
jurisdiction = "eu"
```

**Key Structure:**

```
artifacts/{requestId}/{timestamp}.json
├── id: string
├── content: object
└── metadata: object
       └── savedAt: ISO string

worklogs/{taskId}/{timestamp}-{agent}.json
├── taskId: string
├── agent: string
└── result: object
```

**Retention:** Optional lifecycle rules (configure in dashboard for auto-deletion after 90 days).

---

### agent-memory-prod

**Purpose:** Long-term user context, patterns, analysis history.

**Create:**

```bash
wrangler r2 bucket create agent-memory-prod --location eu
```

**Binding Name:** `R2_MEMORY`

**Binding in wrangler.toml:**

```toml
[[r2_buckets]]
binding = "R2_MEMORY"
bucket_name = "agent-memory-prod"
jurisdiction = "eu"
```

**Key Structure:**

```
user-memory/{userId}/{key}.json
├── key: string
├── value: object
└── updatedAt: ISO string
```

**Retention:** Long-term (no auto-deletion suggested for user memory).

---

## 3. AI Gateway

### Route Setup

The AI Gateway provides multi-model access with built-in caching and rate limiting.

**Prerequisites:**

1. Ensure your Cloudflare account has AI Gateway enabled
2. Have API token with sufficient permissions

**Routes to Create:**

| Route Name | Model | Purpose |
|-----------|-------|---------|
| `small-model-route` | `@cf/mistral/mistral-7b-instruct-v0.1` | Fast analysis (analyst agent) |
| `large-model-route` | `@cf/meta-llama/llama-2-7b-chat-int8` | Complex reasoning (drafting) |
| `fallback-route` | `@cf/openchat/openchat-3.5` | Emergency fallback |

**Setup via Dashboard:**

1. Log in to Cloudflare Dashboard
2. Navigate: Workers & Pages → AI Gateway
3. Create routes for each model above
4. Copy the route paths and credentials

**Bindings in wrangler.toml:**

```toml
[env.production.vars]
AI_GATEWAY_ACCOUNT_ID = "YOUR_ACCOUNT_ID"
AI_GATEWAY_AUTH_TOKEN = "YOUR_API_TOKEN"
AI_GATEWAY_SMALL_MODEL_ROUTE = "small-model-route"
AI_GATEWAY_LARGE_MODEL_ROUTE = "large-model-route"
AI_GATEWAY_FALLBACK_ROUTE = "fallback-route"
```

**API Call Pattern:**

```typescript
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/${routeName}`;
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    messages: [ { role: 'user', content: 'Your prompt here' } ],
    temperature: 0.7,
    maxTokens: 2000
  })
});
```

---

## 4. KV Namespace (Optional, Phase 2)

**Purpose:** Fast caching layer for frequently accessed data.

**Create:**

```bash
wrangler kv:namespace create CACHE
```

**Bind in wrangler.toml:**

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "YOUR_KV_ID"
```

**Use Case:**

- Cache AI Gateway responses
- Cache user context for repeated requests
- Store session state

---

## 5. Workflows (Optional, Phase 3)

**Purpose:** Durable multi-step agent orchestration with built-in retry logic.

**Enable in wrangler.toml:**

```toml
[workflows]
main = "src/workflows/task-workflow.ts"
```

**Usage:**

```typescript
// In agent or main worker
await env.WORKFLOWS.create('task-execution-workflow', {
  taskId: 'task-123',
  steps: [
    { type: 'agent', agentType: 'analyst' },
    { type: 'agent', agentType: 'drafting' },
    { type: 'agent', agentType: 'audit' }
  ]
});
```

---

## 6. Analytics Engine (Optional, Phase 4)

**Purpose:** Custom metrics (agent execution times, audit scores, error rates).

**Enable in wrangler.toml:**

```toml
[[analytics_engine_datasets]]
binding = "ANALYTICS"
```

**Usage:**

```typescript
// Log custom metric
env.ANALYTICS.writeDataPoint({
  indexes: ['dispatcher'],
  blobs: ['request-id-123'],
  doubles: [0.85] // confidence score
});
```

---

## 7. Cloudflare Access (Recommended for Production)

**Purpose:** Secure the worker endpoint with zero-trust auth.

**Setup:**

1. Go to Cloudflare Dashboard → Access
2. Create Application policy for your worker domain
3. Restrict to specific users/groups
4. Add to wrangler.toml routes (if using named routes)

---

## Summary of Bindings

| Binding | Type | Required | Phase |
|---------|------|----------|-------|
| `TASK_COORDINATOR` | Durable Object | Yes | 1 |
| `R2_ARTIFACTS` | R2 Bucket | Yes | 1 |
| `R2_MEMORY` | R2 Bucket | Yes | 1 |
| `AI_GATEWAY_*` | Environment vars | Yes | 1 |
| `CACHE` | KV Namespace | No | 2 |
| `WORKFLOWS` | Workflows | No | 3 |
| `ANALYTICS` | Analytics Engine | No | 4 |

---

## Provisioning Checklist

### Phase 1 (Minimal)

- [ ] Create R2 buckets: `agent-artifacts-prod`, `agent-memory-prod`
- [ ] Set up AI Gateway routes (small, large, fallback)
- [ ] Copy credentials to wrangler.toml
- [ ] Deploy: `npm run deploy:prod`

### Phase 2+

- [ ] Create KV namespace `CACHE`
- [ ] Set up Workflows script (if using workflow orchestration)
- [ ] Configure Analytics Engine bindings

### Production Hardening

- [ ] Enable Cloudflare Access on worker domain
- [ ] Set up rate limiting rules
- [ ] Configure WAF rules for POST endpoints
- [ ] Enable request logging via Logpush

---

## Troubleshooting

### "Could not find namespace for binding TASK_COORDINATOR"

**Cause:** Durable Objects not migrated or registered.

**Solution:**
1. Run: `wrangler migrations create add_task_coordinator`
2. Deploy to get the migration ID
3. Update `wrangler.toml` with migration ID

### "R2 bucket not found"

**Cause:** Bucket name mismatch between `wrangler.toml` and creation.

**Solution:**
1. List buckets: `wrangler r2 bucket list`
2. Verify names match exactly in `wrangler.toml`

### "AI Gateway authentication failed (403)"

**Cause:** Invalid token or route name.

**Solution:**
1. Regenerate API token from Cloudflare dashboard
2. Verify route names exist in AI Gateway
3. Check account ID is correct

---

## Cost Estimates

**Rough monthly cost (small prototype):**

- **Durable Objects:** $0.15/million requests + $0.15/instance-hour ≈ $5-20/month
- **R2:** $0.015/GB stored ≈ $1-5/month (depends on artifact size)
- **AI Gateway:** Included with Workers (or $0.14/million requests if heavy)
- **KV (optional):** $0.50/million ops ≈ $0-5/month
- **Workflows (optional):** $0.50/million steps ≈ $1-10/month

**Total estimate:** $8-50/month for a small prototype.

---

## Security Best Practices

1. **API Token Rotation:** Rotate every 90 days
2. **Least Privilege:** Grant only needed permissions to tokens
3. **Environment Parity:** Test in staging before production
4. **Logging:** Enable Logpush for audit trails
5. **Access Control:** Use Cloudflare Access for authentication

