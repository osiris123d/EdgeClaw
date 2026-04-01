# MVP Reduction Plan - Cloudflare Agent Prototype

**Goal:** Ship smallest useful agent system (1,500–1,800 LOC vs. current 4,450)  
**Timeline:** 2–3 coding sessions (6–8 hours total)  
**Target Date:** Next sprint

---

## 1. Final MVP File List

### ✅ Keep (Core)

```
src/
├── agents/
│   ├── DispatcherAgent.ts          (200 LOC) - NLP classification → 3 types only
│   ├── AnalystAgent.ts             (250 LOC) - Context + hypothesis (unchanged)
│   └── AuditAgent.ts               (280 LOC) - Quality gate (remove AI paths)
├── workflows/
│   └── TaskWorkflow.ts             (300 LOC) - Orchestrate Dispatcher → Analyst → Audit
├── durable/
│   └── TaskCoordinatorDO.ts        (200 LOC) - State machine (fix lease logic)
├── lib/
│   ├── types.ts                    (80 LOC)  - Shared types (remove 15 unused env vars)
│   └── chat.ts                     (200 LOC) - Minimal web chat UI + SSE (convert to polling)
├── index.ts                        (180 LOC) - HTTP router (10 routes → 4 routes)
└── wrangler.toml                   (Standard) - R2 + DO bindings only

tests/
├── helpers/
│   └── cloudflare-mocks.ts         (80 LOC)  - R2/DO test mocks
├── unit/
│   ├── dispatcher-classification.test.ts   (20 LOC) - 3 types only
│   └── r2-keys.test.ts             (20 LOC) - Key generation
└── integration/
    └── task-workflow.test.ts       (40 LOC) - Full e2e flow

package.json, tsconfig.json, README.md (keep as-is with minor updates)
```

**Total MVP files:** 11 active source files + 5 test files + config

---

### ❌ Delete (Deferred to Phase 2+)

```
DELETED:
├── src/lib/browser-automation.ts     (280 LOC) → Phase 2
├── src/lib/dynamic-worker.ts         (250 LOC) → Phase 2
├── src/lib/chat-adapters.ts          (290 LOC) → Phase 2
├── src/lib/logger.ts                 (100 LOC) → Phase 2
├── src/durable/QueueDO.ts            (150 LOC) → Replace with Queues API
├── src/agents/DraftingAgent.ts       (280 LOC) → Merged into Analyst for MVP
│
tests/
├── unit/worklog.test.ts              (40 LOC)  → Test formatting
├── unit/approval-transitions.test.ts (50 LOC)  → Simplified
└── integration/ (incomplete)         (80 LOC)  → Cut to minimal e2e

CONFIG UPDATES:
├── tsconfig.json - Remove 5 file includes
├── types.ts - Remove BROWSER_RENDERING_*, DYNAMIC_WORKER_*, LOG_LEVEL, etc.
└── wrangler.toml - Keep only TASK_COORDINATOR, R2_ARTIFACTS, R2_WORKLOGS
```

---

## 2. Final MVP Architecture

### Simplified Workflow

```
┌─────────────────────────────────────────────┐
│         Cloudflare Worker                   │
├─────────────────────────────────────────────┤
│                                              │
│  POST /tasks (create)                       │
│  POST /tasks/run (execute workflow)         │
│  POST /tasks/:id/approve (approve)          │
│  GET /chat (web UI)                         │
│  POST /chat/message (send message)          │
│                                              │
│  ┌───────────────────────────────────────┐  │
│  │  Dispatcher (3 types)                 │  │
│  │  ├─ change_review                     │  │
│  │  ├─ incident_triage                   │  │
│  │  └─ report_draft                      │  │
│  └───────────────────────────────────────┘  │
│           ↓                                   │
│  ┌───────────────────────────────────────┐  │
│  │  Task Workflow (3 steps)              │  │
│  │  1. Analyst (generate findings)       │  │
│  │  2. Audit (quality gate)              │  │
│  │  3. Finalize (persist to R2)          │  │
│  └───────────────────────────────────────┘  │
│           ↓                                   │
│  ┌───────────────────────────────────────┐  │
│  │  TaskCoordinatorDO (per-task state)   │  │
│  │  ├─ Status: pending/analyzing/paused  │  │
│  │  ├─ Lease-based mutation control      │  │
│  │  └─ Approval gate (pause/resume)      │  │
│  └───────────────────────────────────────┘  │
│           ↓                                   │
│  ┌───────────────────────────────────────┐  │
│  │  R2 Storage                           │  │
│  │  ├─ tasks/{taskId}/state.json         │  │
│  │  └─ worklogs/{taskId}.log             │  │
│  └───────────────────────────────────────┘  │
│                                              │
│  Chat Sessions → KV (auto-expire 24h)       │
│                                              │
└─────────────────────────────────────────────┘
```

### Data Flow (Minimal)

```
1. User submits task via chat/API
   POST /tasks { userId, message }
   → Returns: taskId, status

2. Dispatcher classifies intent
   message → "change_review" | "incident_triage" | "report_draft"

3. TaskWorkflow orchestrates 3 steps:
   Step 1: AnalystAgent (gather context, form hypothesis)
           → Finds relevant docs, patterns, risks
   
   Step 2: AuditAgent (deterministic quality check)
           → Rules-based verdict (approve/hold/reject)
           → If hold: save state, wait for human approval
   
   Step 3: Finalize (persist to R2)
           → save task/{taskId}/state.json
           → append to worklogs/{taskId}.log

4. User polls for updates or receives webhook
   GET /chat/messages/{sessionId}
   → Returns: latest messages, task status

5. User approves task (if paused)
   POST /tasks/{taskId}/approve
   → Resume workflow from step 2
```

---

## 3. Code Changes Required

### Session 1: Delete Non-MVP Files (1 hour)

1. Delete `src/lib/browser-automation.ts`
2. Delete `src/lib/dynamic-worker.ts`
3. Delete `src/lib/chat-adapters.ts`
4. Delete `src/lib/logger.ts`
5. Delete `src/durable/QueueDO.ts`
6. Delete `src/agents/DraftingAgent.ts`
7. Delete `tests/unit/worklog.test.ts`
8. Delete `tests/unit/approval-transitions.test.ts`

**Files remaining:** 11 source + 3 test files

---

### Session 2: Simplify Core Components (3–4 hours)

#### A. DispatcherAgent - Reduce to 3 Types

**File:** `src/agents/DispatcherAgent.ts`

```typescript
// BEFORE: 23 task types
const TASK_TYPES = [
  'change_review', 'incident_triage', 'report_draft',
  'config_audit', 'compliance_check', 'capacity_planning',
  // ... 17 more
];

// AFTER: 3 types only
const TASK_TYPES = [
  'change_review',
  'incident_triage',
  'report_draft'
];

const DOMAINS = ['network', 'security', 'infrastructure'];

// Simplify classify() logic
classify(message: string): { type: string; domain: string; confidence: number } {
  if (message.includes('change') || message.includes('policy')) {
    return { type: 'change_review', domain: detectDomain(message), confidence: 0.85 };
  }
  if (message.includes('incident') || message.includes('outage')) {
    return { type: 'incident_triage', domain: detectDomain(message), confidence: 0.8 };
  }
  return { type: 'report_draft', domain: detectDomain(message), confidence: 0.7 };
}
```

**Changes:**
- Delete 20 type definitions
- Simplify classify() from 100+ lines → 30 lines
- Remove complex confidence scoring
- **Result:** 200 LOC (was 250)

---

#### B. AnalystAgent - No Changes

Keep as-is. This is the core intelligence.

**References unchanged:** 250 LOC

---

#### C. AuditAgent - Remove AI Gateway Paths

**File:** `src/agents/AuditAgent.ts`

```typescript
// BEFORE: AI-assisted fallback
async audit() {
  const deterministic = this.runDeterministicAudit();
  if (!deterministic.approved && process.env.AI_GATEWAY_ENABLED) {
    try {
      const aiResult = await this.callAIGateway();
      return this.mergeAuditResults(deterministic, aiResult);
    } catch {
      return deterministic;
    }
  }
  return deterministic;
}

// AFTER: Deterministic only
async audit() {
  return this.runDeterministicAudit();
}
```

**Changes:**
- Delete AI Gateway integration (30 lines)
- Delete mergeAuditResults() (20 lines)
- Keep deterministic rules engine intact
- **Result:** 250 LOC (was 280)

---

#### D. TaskWorkflow - Simplify to 3 Steps

**File:** `src/workflows/TaskWorkflow.ts`

```typescript
// BEFORE: 5–7 steps
const steps = ['load', 'analyst', 'draft', 'audit', 'finalize'];

// AFTER: 3 steps (load merged into analyst context lookup)
async run() {
  // Step 1: Analyst
  const analysis = await this.analyst.analyze(context);
  
  // Step 2: Audit
  const audit = await this.auditor.audit(analysis);
  if (audit.verdict === 'hold') {
    await this.coordinator.pauseForApproval(taskId);
    return { status: 'paused', taskId };
  }
  
  // Step 3: Finalize
  await this.coordinator.finalize(taskId, analysis, audit);
  return { status: 'completed', taskId };
}
```

**Changes:**
- Remove "load" as separate step (fold into analyst.analyze context)
- Remove "draft" step (analyst + audit produces final output)
- Simplify retry logic (no per-step backoff)
- **Result:** 200–250 LOC (was 300)

---

#### E. TaskCoordinatorDO - Fix Lease Logic & Simplify

**File:** `src/durable/TaskCoordinatorDO.ts`

```typescript
// CRITICAL FIX: Replace boolean flag with versioned storage
// BEFORE: Race condition
if (this.hasLease) return { ok: false };
this.hasLease = true;

// AFTER: Atomic CAS
const current = this.storage.get('lease');
if (current?.expiresAt > Date.now()) {
  return { ok: false, error: 'Lease held by another worker' };
}
this.storage.put('lease', {
  stepName,
  expiresAt: Date.now() + 30000,
  version: (current?.version ?? 0) + 1
});
return { ok: true };
```

**Changes:**
- Fix TOCTOU race in acquireLease()
- Simplify state machine: pending → analyzing → paused | completed
- Remove complex status transitions
- Add R2 write retry logic (exponential backoff)
- **Result:** 200 LOC (was 250, but adds retry wrapper)

---

#### F. Chat - Convert SSE to Polling + Switch to KV

**File:** `src/lib/chat.ts`

```typescript
// BEFORE: R2 + SSE streaming (holds HTTP connection open)
POST /api/chat/:sid/messages
  → await TaskWorkflow.run() (60–120s)
  → stream updates via SSE
  → timeout if > 30s

// AFTER: Polling + KV sessions
POST /tasks
  → return { taskId, status: 'created' } (202 Accepted)
  → enqueue to background processor (future: Queues API)

GET /chat/messages/:sessionId
  → return last 10 messages from KV
  → client polls every 2–5s

POST /chat/messages/:sessionId
  → create session if not exists
  → append message to KV array
  → trigger async task creation
```

**Changes:**
- Remove SSE streaming endpoint
- Add polling endpoint (GET /chat/messages)
- Use KV for session storage (fast, cheap, auto-expire)
- Remove HTTP timeout risk
- **Result:** 150 LOC (was 200, but simpler)

---

#### G. index.ts - Reduce Routes

**File:** `src/index.ts`

```typescript
// Routes: 10 → 4
GET  /                           (serve chat HTML)
POST /tasks                      (create task, return immediately)
POST /tasks/:id/approve          (approve paused task)
GET  /chat/messages/:sessionId   (polling endpoint)
```

**Remove routes:**
- POST /api/chat/sessions
- POST /api/chat/sessions/:sid/messages (SSE)
- POST /webhooks/teams, /webhooks/discord, etc.
- POST /tasks/run-next

**Changes:**
- Delete 150+ lines of route handlers
- Simplify request validation
- Remove webhook signature verification (Phase 2)
- **Result:** 150–180 LOC (was 250+)

---

#### H. types.ts - Clean Up Env

**File:** `src/lib/types.ts`

```typescript
// BEFORE: 15+ optional config variables
interface Env {
  TASK_COORDINATOR: DurableObjectNamespace;
  R2_ARTIFACTS: R2Bucket;
  R2_WORKLOGS: R2Bucket;
  
  LOG_LEVEL?: string;                               // ← Remove
  ENVIRONMENT?: string;                             // ← Remove
  BROWSER_RENDERING_ENABLED?: boolean;              // ← Remove
  BROWSER_RENDERING_API_*?: string;                 // ← Remove
  DYNAMIC_WORKER_*?: string;                        // ← Remove
  AI_GATEWAY_*?: string;                            // ← Remove
  AUTO_START_WORKFLOW?: boolean;                    // ← Remove
  // ... more unused
}

// AFTER: Minimal
interface Env {
  TASK_COORDINATOR: DurableObjectNamespace;
  R2_ARTIFACTS: R2Bucket;
  R2_WORKLOGS: R2Bucket;
}

// Task types: 23 → 3
type TaskType = 'change_review' | 'incident_triage' | 'report_draft';

// Status: 6 → 3
type TaskStatus = 'pending' | 'analyzing' | 'completed' | 'paused';
```

**Changes:**
- Remove all Phase 2+ config variables
- Simplify type unions (task types, status)
- **Result:** 60 LOC (was 100)

---

#### I. tsconfig.json - Update Includes

**File:** `tsconfig.json`

```json
{
  "include": [
    "src/index.ts",
    "src/agents/*.ts",
    "src/workflows/*.ts",
    "src/durable/*.ts",
    "src/lib/types.ts",
    "src/lib/chat.ts",
    // Remove:
    // "src/lib/browser-automation.ts",
    // "src/lib/dynamic-worker.ts",
    // "src/lib/chat-adapters.ts",
    // "src/lib/logger.ts"
  ]
}
```

---

### Session 3: Testing & Validation (2–3 hours)

#### A. Simplify Tests

**Keep:**
- `tests/helpers/cloudflare-mocks.ts` (80 LOC) — unchanged
- `tests/unit/dispatcher-classification.test.ts` (20 LOC) — reduce to 3 test cases
- `tests/unit/r2-keys.test.ts` (20 LOC) — unchanged
- `tests/integration/task-workflow.test.ts` (40 LOC) — single e2e flow

**Delete:**
- `tests/unit/worklog.test.ts`
- `tests/unit/approval-transitions.test.ts`
- Reduce integration suite to 1 happy-path test

**Total:** 8 tests (was 14)

---

#### B. Update README.md

**Changes:**
- Remove browser rendering section
- Remove dynamic worker section
- Remove chat adapters section
- Keep: "What is this", "Architecture", "Setup", "Deployment", "How Task Flow Works"
- Cut down "Future Roadmap" to mention Phase 2

---

#### C. Test Coverage

```bash
npm test
# Expected output:
✓ dispatcher-classification.test.ts (3)
  ✓ change_review classification
  ✓ incident_triage classification
  ✓ report_draft classification

✓ r2-keys.test.ts (2)
  ✓ generates deterministic keys
  ✓ sanitizes whitespace

✓ task-workflow.test.ts (1)
  ✓ full flow: dispatch → analyst → audit → finalize

Tests: 6 passed (vs. 14 currently)
```

---

## 4. Recommended Build Order (2–3 Sessions)

### Session 1: Cleanup (1–1.5 hours)

**Goal:** Delete all Phase 2+ code, update config

1. Delete 6 source files (browser, dynamic, adapters, logger, queue, drafting)
2. Delete 2 test files (worklog, approval-transitions)
3. Update `tsconfig.json` to remove 5 includes
4. Commit: "refactor: delete phase-2+ components"

**Validation:**
```bash
npm test
# Should still pass (files deleted, not logic changed)
```

---

### Session 2: Simplify Core Logic (3–4 hours)

**Goal:** Reduce logic, fix critical bugs, reorganize

1. **DispatcherAgent:** Reduce from 23 → 3 types (30 min)
2. **AuditAgent:** Remove AI Gateway paths (30 min)
3. **TaskWorkflow:** 3-step orchestration only (1 hour)
4. **TaskCoordinatorDO:** Fix lease logic + add R2 retry (1 hour)
5. **types.ts:** Clean up Env interface (20 min)
6. **Chat:** Convert SSE → polling, add KV (1 hour)
7. **index.ts:** Reduce to 4 routes (30 min)
8. Run tests after each change
9. Commit: "refactor: simplify to 3-step workflow"

**Validation:**
```bash
npm test
npm run dev
curl -X POST http://localhost:8787/tasks \
  -H "Content-Type: application/json" \
  -d '{"userId":"user1","message":"audit NAC policy changes"}'
# Should return: { taskId, status: "pending" }
```

---

### Session 3: Testing & Documentation (1.5–2 hours)

**Goal:** Validate MVP, update docs, finalize

1. **Simplify tests:** Keep 4 essential test cases (30 min)
2. **Test e2e flow:** Full task submission → audit (1 hour)
3. **Update README.md:** Remove Phase 2 sections (20 min)
4. **Create ARCHITECTURE.md:** One-page MVP architecture (20 min)
5. Run full test suite: `npm test`
6. Run locally: `npm run dev` + manual test
7. Final commit: "chore: finalize MVP (1.7k LOC, 3 task types, 3 steps)"

**Validation:**
```bash
npm test    # All green
npm run dev # Server starts
# Manual test in chat UI or via curl
```

---

## 5. Final MVP Metrics

### Code Size

| Component | Current | MVP | % Reduction |
|-----------|---------|-----|-------------|
| src/agents | 1,100 | 500 | -55% |
| src/workflows | 800 | 250 | -69% |
| src/durable | 600 | 200 | -67% |
| src/lib | 800 | 150 | -81% |
| src/index.ts | 500 | 180 | -64% |
| tests | 350 | 160 | -54% |
| **Total** | **4,450** | **1,540** | **-65%** |

### Functionality

| Feature | Current | MVP |
|---------|---------|-----|
| Task types | 23 | 3 |
| Agent pipeline | 4 agents | 2 agents (Analyst, Audit) |
| Orchestration steps | 5–7 | 3 |
| HTTP routes | 10+ | 4 |
| Chat platforms | 1 web + 4 placeholder | 1 web |
| External integrations | 3 (hover, dynamic, chat) | 0 (MVP only) |
| Database layers | R2 + KV (sessions) + DO | R2 + KV + DO |
| Auth | None | None (Phase 2) |

### Risk Reduction

| Risk | Status |
|------|--------|
| HTTP timeout (30s) | ✅ Fixed (polling instead of SSE) |
| Durable Object lease race | ✅ Fixed (atomic storage ops) |
| TaskID collisions | ✅ Fixed (server-generated UUID) |
| R2 write failures | ✅ Fixed (retry + backoff) |
| Auth/multi-tenancy | ⏳ Deferred (Phase 2) |
| External chat integrations | ⏳ Deferred (Phase 2) |

---

## 6. Phase 2 Roadmap (After MVP Shipping)

Once MVP validates the agent loop:

- **Phase 2:** Browser rendering + Dynamic workers (4 weeks)
- **Phase 3:** External chat adapters + multi-tenancy (4 weeks)
- **Phase 4:** Enterprise connectors + SSO (6 weeks)

---

## Success Criteria

✅ **MVP is done when:**

1. All 6 tests pass
2. Manual e2e flow works: submit task → classify → analyze → audit → finalize
3. `npm run dev` starts without errors
4. `wrangler publish --env production` deploys successfully
5. Code is under 1,700 LOC
6. README reflects Phase 1 scope only
7. Zero critical issues from review checklist

---

## Timeline Summary

| Session | Task | Time | Outcome |
|---------|------|------|---------|
| 1 | Delete Phase 2+, update config | 1h | Clean git history |
| 2 | Simplify core, fix bugs | 3.5h | Working MVP |
| 3 | Test, docs, final polish | 2h | Ship-ready |
| **Total** | | **6.5h** | **Shipping MVP** |

