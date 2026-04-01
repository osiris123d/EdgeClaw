# Cloudflare Agent Prototype — Build Phases & Milestones

## Phase Overview

This document provides detailed guidance for implementing the agent prototype across four phases.

---

## Phase 1: Foundation (Current)
**Goal:** Working prototype with core agent pipeline and persistence.  
**Duration:** 5 days  
**Status:** ✅ COMPLETE

### Deliverables

- [x] Project scaffold (folder structure, TypeScript config)
- [x] Wrangler configuration (wrangler.toml)
- [x] Base agent class with common utilities
- [x] Dispatcher agent (request router)
- [x] Analyst agent (with AI Gateway placeholder)
- [x] Drafting agent (output formatting)
- [x] Audit agent (validation & risk detection)
- [x] Task Coordinator Durable Object
- [x] R2 Store utilities
- [x] Main worker entry point
- [x] Architecture documentation
- [x] API reference documentation
- [x] Quick start guide

### Key Files

- `src/agents/` — All 4 agent implementations
- `src/durable-objects/task-coordinator.ts` — State coordination
- `src/r2/store.ts` — Artifact/memory persistence
- `src/index.ts` — Main orchestration
- `ARCHITECTURE.md` — Design overview
- `docs/API.md` — REST API reference
- `QUICKSTART.md` — Setup guide

### Testing Strategy

**Manual testing via curl:**

```bash
# Test dispatcher + analyst + audit pipeline
curl -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -d '{
    "id": "phase1-test",
    "userId": "user-001",
    "type": "analyze",
    "data": "Test data"
  }'

# Expected: success response with result, audit score, and artifact key
```

### Success Criteria

- [x] All agents execute without errors
- [x] Dispatcher routes requests to correct agent
- [x] Audit validates outputs and returns score
- [x] Results stored in R2
- [x] TypeScript compiles without errors
- [x] Documentation complete and accurate

### Known Limitations

1. **AI Gateway calls are mocked** — Analyst returns test response, not real LLM
2. **No authentication** — Worker endpoint is public (add in Phase 2)
3. **No rate limiting** — All requests processed immediately (add in Phase 3)
4. **No Workflows** — Single-step execution only (add in Phase 3)
5. **Task Coordinator untested at scale** — Test with >100 concurrent tasks in Phase 3

---

## Phase 2: Integration & Testing
**Goal:** Real AI Gateway integration, comprehensive tests, polished API.  
**Duration:** 5 days  
**Status:** TODO

### Deliverables

- [ ] Real AI Gateway calls (replace mock in analyst.ts)
- [ ] Unit tests for each agent
- [ ] Integration tests (full pipeline)
- [ ] API authentication middleware
- [ ] Postman/OpenAPI spec
- [ ] Basic load testing script
- [ ] Enhanced error messages

### Team Tasks

| Task | Owner | Est. Time |
|------|-------|-----------|
| Implement real AI Gateway calls | - | 2 hours |
| Write unit tests (agents) | - | 4 hours |
| Write integration tests | - | 3 hours |
| Add request authentication | - | 2 hours |
| Create OpenAPI spec | - | 2 hours |
| Load test locally | - | 2 hours |
| Update API docs | - | 1 hour |

### Implementation Guide: Real AI Gateway

**File:** `src/agents/analyst.ts`

Replace the mock `callAIGateway` method:

```typescript
private async callAIGateway(request: AIGatewayRequest): Promise<AIGatewayResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai-gateway/${this.modelRoute}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${this.authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`AI Gateway error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
```

### Unit Test Template

**File:** `tests/unit/agents/analyst.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { AnalystAgent } from '../../../src/agents/analyst';
import { createAgentContext } from '../../../src/agents/base-agent';

describe('AnalystAgent', () => {
  it('should analyze text data', async () => {
    const context = createAgentContext('req-1', 'user-1');
    const agent = new AnalystAgent(context, 'account-id', 'token', 'route');
    
    const result = await agent.execute({
      data: 'Sales up 20%'
    });

    expect(result.status).toBe('success');
    expect(result.output).toBeDefined();
  });

  // Additional tests...
});
```

### Integration Test Example

**File:** `tests/integration/pipeline.test.ts`

```typescript
describe('Agent Pipeline', () => {
  it('should process full request through all agents', async () => {
    const response = await fetch('http://localhost:8787/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-' + Date.now(),
        userId: 'user-1',
        type: 'analyze',
        data: 'Test data'
      })
    });

    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.audit.approved).toBeDefined();
    expect(result.artifactKey).toBeDefined();
  });
});
```

### Success Criteria

- [ ] All unit tests pass (>80% code coverage)
- [ ] Integration tests cover happy path + error cases
- [ ] Real AI Gateway calls working (tested in staging)
- [ ] Request authentication enforced via middleware
- [ ] OpenAPI spec generated and accurate
- [ ] Load tests show <500ms p95 latency
- [ ] GitHub CI/CD pipeline runs tests on PR

---

## Phase 3: Durability & Scale
**Goal:** Production-ready with Workflows, rate limiting, and error recovery.  
**Duration:** 7 days  
**Status:** TODO

### Deliverables

- [ ] Workflows implementation for multi-step orchestration
- [ ] Rate limiting per user (via Durable Objects)
- [ ] Retry logic with exponential backoff
- [ ] WorkLog Durable Object (task history)
- [ ] Cloudflare KV for caching
- [ ] Load testing at scale (1,000+ concurrent)
- [ ] Monitoring & alerting setup

### Workflows Implementation

**File:** `src/workflows/task-workflow.ts`

```typescript
import { Workflow } from 'cloudflare:workflows';

export class TaskWorkflow extends Workflow {
  async execute(params: WorkflowParams): Promise<unknown> {
    const { taskId, requestId, userId } = params;

    // Step 1: Run dispatcher
    const decision = await this.runTask('dispatcher', { requestId });

    // Step 2: Run specialized agent
    const result = await this.runTask(decision.targetAgent, { taskId, requestId });

    // Step 3: Run audit
    const auditResult = await this.runTask('audit', { content: result });

    // Step 4: Save to R2
    await this.runTask('save-artifact', { taskId, result });

    return { taskId, approved: auditResult.approved };
  }
}
```

**Usage in main worker:**

```typescript
// In index.ts
const workflow = await env.WORKFLOWS.create('task-workflow', {
  taskId: context.requestId,
  requestId: context.requestId,
  userId: context.userId
});
```

### Rate Limiting Decorator

**File:** `src/utils/rate-limiter.ts`

```typescript
export class RateLimiter {
  private doNamespace: DurableObjectNamespace;

  async checkLimit(userId: string): Promise<boolean> {
    const id = this.doNamespace.idFromName(userId);
    const stub = this.doNamespace.get(id);
    
    const response = await stub.fetch(
      new Request('https://limit-check', { method: 'POST' })
    );
    
    return response.status === 200;
  }
}
```

### Success Criteria

- [ ] Workflows execute multi-step tasks durably
- [ ] Rate limiting enforces per-user quotas
- [ ] Retries succeed after transient failures
- [ ] KV cache improves response times by >30%
- [ ] Load testing shows linear scaling up to 1,000 RPS
- [ ] 99.9% uptime during staging load tests
- [ ] Error logs tagged for alerting

---

## Phase 4: Polish & Production
**Goal:** Document, secure, and launch.  
**Duration:** 5 days  
**Status:** TODO

### Deliverables

- [ ] Cloudflare Access authentication
- [ ] WAF rules for POST endpoints
- [ ] Logpush to external analytics
- [ ] Browser Rendering placeholder (if applicable)
- [ ] Analytics Engine metrics
- [ ] Production deployment guide
- [ ] Security audit & fixes
- [ ] Performance optimization

### Deployment Checklist

- [ ] Review OWASP top 10 (check for vulnerabilities)
- [ ] Enable Cloudflare Access on API routes
- [ ] Set up WAF rules (rate limiting, bot protection)
- [ ] Configure CORS headers (if client-facing)
- [ ] Enable request logging via Logpush
- [ ] Set up error alerts (PagerDuty/Slack)
- [ ] Backup R2 buckets (Durabit)
- [ ] Document incident response procedures

### Monitoring Metrics

**Set up Analytics Engine:**

```typescript
// In agents
env.ANALYTICS.writeDataPoint({
  indexes: [agent.name],
  blobs: [context.userId],
  doubles: [executionTime]
});
```

**Query dashboard:**
- Agent execution time distribution
- Audit approval rate
- Error rate by agent type
- Cache hit ratio

### Success Criteria

- [ ] Zero security vulnerabilities (OWASP scan)
- [ ] All requests authenticated
- [ ] Monitoring & alerting active
- [ ] 99.95% uptime SLA achievable
- [ ] Documentation complete & reviewed
- [ ] Team trained on incident response
- [ ] Launch approved by stakeholders

---

## Cross-Phase: Testing Strategy

### Unit Tests
- Test each agent in isolation
- Mock dependencies (AI Gateway, R2)
- Target 80%+ code coverage

### Integration Tests
- Test full request pipeline
- Use real Wrangler dev server
- Cover happy path + error cases

### Load Testing
- Phase 2: 100 concurrent requests
- Phase 3: 1,000 concurrent requests
- Tools: k6, Artillery, or Apache JMeter

### Staging Environment
- Separate `wrangler.toml` config ([env.staging])
- Real R2 buckets but isolated data
- Non-production AI Gateway routes
- Bluegreen deployments for zero downtime

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| AI Gateway unavailable | High | Implement fallback route + circuit breaker |
| R2 bucket quota exceeded | Medium | Monitor bucket size, archive old artifacts |
| Durable Object state loss | Low | Regular snapshots, DO storage backups |
| Rate limiting errors | Medium | Test under load in Phase 3 |
| Authentication bypass | Critical | Security audit in Phase 4 |

---

## Success Metrics

By Phase 4 completion:

- **Availability:** 99.95% uptime
- **Performance:** <500ms p95 latency
- **Reliability:** <0.1% error rate
- **Security:** Zero OWASP vulnerabilities
- **Scale:** Handle 1,000+ concurrent users
- **Quality:** >80% test coverage

---

## Timeline Summary

```
Week 1: Phase 1 (Foundation) ✅
Week 2: Phase 2 (Integration + Testing)
Week 3: Phase 3 (Durability + Scale)
Week 4: Phase 4 (Polish + Production)
```

**Total Duration:** 4 weeks  
**Start Date:** [Insert date]  
**Target Launch:** [Insert date + 28 days]

---

## Next Steps (After Phase 1)

1. **Review** this document with team
2. **Assign** owners to Phase 2 tasks
3. **Schedule** daily standups (15 min)
4. **Set up** staging environment
5. **Create** GitHub issues for each task
6. **Begin** Phase 2 (Real AI Gateway integration)

