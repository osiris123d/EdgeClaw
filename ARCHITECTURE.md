# Cloudflare Agent Prototype Architecture

## 1. Proposed Folder Structure

```
src/
├── agents/
│   ├── dispatcher.ts          # Request classifier & router
│   ├── analyst.ts             # Analysis & recommendation agent
│   ├── drafting.ts            # Summary & report generation
│   ├── audit.ts               # Output validation & risk review
│   └── base-agent.ts          # Shared agent interface & utilities
├── durable-objects/
│   ├── task-coordinator.ts    # Manages active agent tasks
│   ├── work-log.ts            # Persistent task/execution history
│   └── migration.ts           # DO schema migrations (if needed)
├── gateway/
│   ├── router.ts              # AI Gateway multi-route handler
│   └── models.ts              # Model routing configuration
├── r2/
│   ├── store.ts               # R2 read/write operations
│   └── artifacts.ts           # Artifact versioning & retrieval
├── workflows/
│   ├── task-workflow.ts       # Durable multi-step task execution
│   └── coordination.ts        # Agent coordination via Workflows
├── index.ts                   # Main worker entry point
├── types.ts                   # Shared TypeScript interfaces
└── config.ts                  # Environment & binding setup

tests/
├── unit/
└── integration/

docs/
├── API.md                     # REST API schema
├── PHASES.md                  # Build phases & milestones
└── BINDINGS.md                # Required Cloudflare resources

wrangler.toml                  # Cloudflare configuration
wrangler.jsonc                 # (Optional: alternative format)
package.json
tsconfig.json
```

## 2. Architecture Explanation

### Core Design Pattern
Three-tier agent system with orchestration and persistence:

```
Request → Dispatcher (Router) → Specialized Agent → Audit (Validator)
                                      ↓
                              Durable Objects (State)
                                      ↓
                              R2 (Long-term Memory)
                                      ↓
                              Workflows (Durability)
```

### Agent Responsibilities

| Agent | Purpose | Input | Output |
|-------|---------|-------|--------|
| **Dispatcher** | Classify request intent & route to handler | Raw user request | Agent type + context |
| **Analyst** | Read data, analyze patterns, recommend actions | Structured context | Analysis report |
| **Drafting** | Create human-readable summaries & formatted output | Analysis results | Formatted document |
| **Audit** | Validate outputs, flag risks, verify accuracy | Draft output | Approved or rejected |

### State & Persistence Layer

- **Durable Objects (Task Coordinator)**: Maintains active task state, prevents duplicate execution, coordinates multi-step flows
- **R2 Buckets**: 
  - `worklogs/` — Task execution history & logs
  - `artifacts/` — Generation outputs (reports, summaries)
  - `memory/` — Long-term context (previous analyses, patterns)
- **Workflows**: Durable job execution for multi-step tasks that must survive worker restarts

### AI Gateway Integration

- Multiple models available via AI Gateway routes
- Route selection by agent type & task complexity
- Fallback routing if primary model unavailable

## 3. Build Plan in Phases

### Phase 1: Foundation (Week 1)
- [ ] Project scaffolding & TypeScript setup
- [ ] Wrangler configuration with basic bindings
- [ ] Base Agent interface & utilities
- [ ] Task Coordinator DO (minimal)
- [ ] R2 integration (write/read artifacts)
- [ ] Simple Dispatcher (hardcoded routes for testing)

### Phase 2: Agent Pipeline (Week 2)
- [ ] Analyst agent with AI Gateway integration
- [ ] Drafting agent for output formatting
- [ ] Audit agent for validation rules
- [ ] Integrate agents into request dispatch flow
- [ ] Basic end-to-end test

### Phase 3: Durability & Scale (Week 3)
- [ ] Workflows for multi-step orchestration
- [ ] Work log persistence (R2 + DO memory)
- [ ] AI Gateway multi-route fallback logic
- [ ] Concurrency limits & rate limiting in DO
- [ ] Error recovery & retry logic

### Phase 4: Polish & Testing (Week 4)
- [ ] Unit tests for each agent
- [ ] Integration tests (full workflow)
- [ ] Load testing & DO scaling verification
- [ ] Documentation & deployment guide
- [ ] Optional: Browser Rendering placeholder (if future UI system needed)

## 4. Required Cloudflare Bindings & Resources

### Bindings in wrangler.toml

```
[env.production]
# Durable Objects
[[durable_objects.bindings]]
name = "TASK_COORDINATOR"
class_name = "TaskCoordinator"
script_name = "cloudflare-agent"

[[durable_objects.bindings]]
name = "WORK_LOG"
class_name = "WorkLog"
script_name = "cloudflare-agent"

# R2 Buckets
[[r2_buckets]]
binding = "R2_ARTIFACTS"
bucket_name = "agent-artifacts-prod"

# AI Gateway
[env.production.vars]
AI_GATEWAY_ACCOUNT_ID = "..."
AI_GATEWAY_AUTH_TOKEN = "..."
AI_GATEWAY_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai-gateway"

# Workflows
[triggers.crons]
# optional: scheduled task trigger
# crons = ["0 */6 * * *"]  # Every 6 hours
```

### Cloudflare Resources to Provision

1. **Durable Objects Classes**
   - `TaskCoordinator` — Active task coordination
   - `WorkLog` — Task history & metadata

2. **R2 Buckets**
   - `agent-artifacts-{env}` — Output artifacts (reports, summaries)
   - `agent-memory-{env}` — Long-term patterns & context

3. **AI Gateway**
   - Create 2-3 routes (small model, large model, fallback)
   - Enable caching for repeated queries

4. **Workflows** (optional, but recommended)
   - `task-execution-workflow` — Multi-step agent pipeline

5. **Service Bindings** (if splitting agents into separate workers)
   - Optional: individual worker per agent type

---

## 5. Wrangler Configuration

See `wrangler.toml` in this directory.

## 6. Package Dependencies

See `package.json` in this directory.

---

## Key Design Decisions

1. **Single Worker Entry Point**: All agents run in one worker with routing. Easier to develop, test, and deploy initially.
2. **Durable Objects for Coordination**: Eliminates need for external consensus; leverages Cloudflare's strong consistency.
3. **R2 as Artifact Store**: Not for real-time state (that's DO's job), but for historical records & outputs.
4. **Workflows for Complex Tasks**: Automatic retry, progress tracking, and multi-step durability.
5. **AI Gateway for Model Abstraction**: Switch models without code changes; built-in rate limiting.
6. **OpenClaw Inspiration**: Audit layer validates all outputs before returning to user; prevents invalid state propagation.

---

## Constraints & Edge Cases

- **Browser Rendering**: Held for UI-only systems (e.g., HTML report rendering). Not needed for agent logic.
- **Dynamic Workers**: Reserved for isolated code execution (if agent generates code dynamically). Not in Phase 1.
- **DO Limits**: Single DO handles coordination; if >100 concurrent agents, consider sharding by task ID.
- **R2 Consistency**: Eventually consistent; workaround: commit metadata to DO first, then R2.

---

**Next Steps:**
1. Review config files (wrangler.toml, package.json, tsconfig.json)
2. Implement Phase 1 (scaffold + Dispatcher + base Agent)
3. Test Dispatcher → Analyst → Audit → R2 round-trip
