# Cloudflare Agent Prototype — Quick Start

## Prerequisites

- Node.js ≥ 18.0
- `npm` or `yarn`
- Cloudflare account with API token
- Wrangler CLI (`npm install -g wrangler` or use via npm script)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Cloudflare Resources

Before deploying, you need to:

1. **Create R2 Buckets:**
   ```bash
   wrangler r2 bucket create agent-artifacts-prod
   wrangler r2 bucket create agent-memory-prod
   ```

2. **Register Durable Objects:**
   - Update `wrangler.toml` with your account ID and environment
   - Durable Objects classes (TaskCoordinator, WorkLog) are auto-registered on first deploy

3. **Configure AI Gateway:**
   - Log in to Cloudflare dashboard
   - Navigate to AI Gateway
   - Create routes for different models (small, large, fallback)
   - Copy credentials to `.env.local` or update `wrangler.toml`

### 3. Set Environment Variables

Create a `.env.local` file in the root:

```env
ENVIRONMENT=development
LOG_LEVEL=debug
AI_GATEWAY_ACCOUNT_ID=your_account_id
AI_GATEWAY_AUTH_TOKEN=your_api_token
AI_GATEWAY_SMALL_MODEL_ROUTE=small-model-route
AI_GATEWAY_LARGE_MODEL_ROUTE=large-model-route
```

### 4. Build

```bash
npm run build
```

Output appears in `dist/`.

### 5. Local Development

```bash
npm run dev
```

This starts a local Wrangler dev server (typically at `http://localhost:8787`).

### 6. Test Locally

```bash
curl -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-001",
    "userId": "user-001",
    "type": "analyze",
    "data": "Monthly revenue up 20%."
  }'
```

Expected response:

```json
{
  "success": true,
  "requestId": "test-001",
  "agentChain": ["dispatcher", "analyst", "audit"],
  "result": {...},
  "audit": {...},
  "artifactKey": "..."
}
```

### 7. Deploy

```bash
npm run deploy:prod
```

This deploys to your Cloudflare Workers account.

---

## Project Structure

```
src/
├── agents/              # Agent implementations
│   ├── base-agent.ts    # Abstract base class
│   ├── dispatcher.ts    # Router agent
│   ├── analyst.ts       # Analysis agent (calls AI Gateway)
│   ├── drafting.ts      # Output formatting agent
│   └── audit.ts         # Validation agent
├── durable-objects/     # Durable Object classes
│   └── task-coordinator.ts
├── r2/                  # R2 bucket operations
│   └── store.ts
├── index.ts            # Main worker entry point
└── types.ts            # Shared TypeScript types

docs/
├── API.md              # REST API documentation
├── ARCHITECTURE.md     # System design
└── PHASES.md           # Build phases

wrangler.toml           # Cloudflare configuration
package.json            # Dependencies
tsconfig.json           # TypeScript config
```

---

## Common Tasks

### Run Tests

```bash
npm run test
```

### Type Check Only

```bash
npm run type-check
```

### Lint Code

```bash
npm run lint
```

### Watch Mode (Dev)

```bash
npm run dev
```

---

## Debugging

### In Browser DevTools

When running `npm run dev`, the worker runs locally. Use:

```javascript
// In the local worker environment
console.log("Debug message");
```

Logs appear in the terminal running the dev server.

### Remote Logs

After deployment, view logs via:

```bash
wrangler tail
```

This streams live logs from your deployed worker.

---

## Troubleshooting

### "Could not resolve entry point" when building

- Ensure TypeScript files exist in `src/`
- Check `tsconfig.json` `include` paths
- Run `npm run build` again

### "Durable Object class not found"

- Ensure `src/durable-objects/task-coordinator.ts` exports the class
- Verify `wrangler.toml` references the correct class name and script

### AI Gateway Returns 403

- Verify `AI_GATEWAY_AUTH_TOKEN` is valid
- Check token has permission for the routes you created
- Confirm account ID matches in requests

### R2 Bucket Errors

- Verify bucket names in `wrangler.toml` match created buckets
- Check Cloudflare account has R2 enabled
- Re-run `wrangler r2 bucket list` to verify creation

---

## Phase 1 Checklist

- [x] TypeScript scaffold
- [x] Wrangler configuration
- [x] Base Agent class
- [x] Dispatcher agent
- [x] Analyst agent (with AI Gateway placeholder)
- [x] Drafting agent
- [x] Audit agent
- [x] Task Coordinator (Durable Object)
- [x] R2 Store (Artifacts & Memory)
- [x] Main worker entry point
- [ ] **TODO:** Unit tests for each agent
- [ ] **TODO:** Integration tests (full pipeline)
- [ ] **TODO:** Load testing

---

## Next Phase: Phase 2 (Agent Integration)

1. Wire audit into the pipeline response
2. Implement actual AI Gateway calls (replace mock)
3. Add data persistence to R2
4. Create simple integration test suite
5. Document API endpoints with Postman or OpenAPI

---

## Support

For issues:
1. Check [ARCHITECTURE.md](ARCHITECTURE.md) for design overview
2. Review [docs/API.md](docs/API.md) for request/response schema
3. Check Cloudflare docs: https://developers.cloudflare.com/workers/
4. Enable debug logging: Set `LOG_LEVEL=debug` in `wrangler.toml`

