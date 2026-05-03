# EdgeClaw / CF_Truth — AI Agent Platform

A production-grade AI agent platform built on **Cloudflare Workers** and **Durable Objects**. Agents run at the edge with persistent durable memory, multi-step browser automation, real-time WebSocket communication, and a React frontend for inspection and management.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Platform capabilities (at a glance)](#platform-capabilities-at-a-glance)
- [Memory System](#memory-system)
  - [Context Blocks](#context-blocks)
  - [Block Label Reference](#block-label-reference)
  - [Message History](#message-history)
  - [Memory REST API](#memory-rest-api)
  - [Memory Page UI](#memory-page-ui)
- [Session Skills](#session-skills)
  - [How Skills Work](#how-skills-work)
  - [Skills vs Tools](#skills-vs-tools)
  - [Configuring Skills](#configuring-skills)
  - [Skills REST API](#skills-rest-api)
  - [Skills UI](#skills-ui)
- [Browser Sessions](#browser-sessions)
  - [Operations](#operations)
  - [Structured Actions](#structured-actions)
  - [Execution Strategies](#execution-strategies)
  - [Human-in-the-Loop (HITL)](#human-in-the-loop-hitl)
- [Cloudflare Browser Run (auth and bindings)](#cloudflare-browser-run-auth-and-bindings)
- [Scheduled tasks and worker cron](#scheduled-tasks-and-worker-cron)
- [Workflows (definitions and runs)](#workflows-definitions-and-runs)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [Sub-agents (Coder, Tester, coordinator)](#sub-agents-coder-tester-coordinator)
- [Getting Started](#getting-started)
  - [First-time deployment checklist](#first-time-deployment-checklist-must-haves-vs-optional)
- [Project Structure](#project-structure)

---

## Architecture Overview

```
Browser / Frontend (React + Vite)
        │  WebSocket + REST
        ▼
Cloudflare Worker  (src/server.ts)
        │  DO fetch / RPC
        ▼
MainAgent Durable Object  (src/agents/MainAgent.ts)
        │
        ├── Think framework (session, memory, system prompt)
        ├── ModelRouter     (Workers AI / AI Gateway)
        ├── BrowserSessionManager  (Browser Run — CDP / Puppeteer)
        ├── MCP client      (remote servers → tools)
        ├── Workflows       (definitions + runs, CF Workflows bindings)
        ├── Tasks           (scheduled tasks persistence)
        ├── Skills          (R2-backed, on-demand context)
        └── REST bridges    (/memory, /skills, /tasks, /mcp, /workflows → DO)
```

- **Workers** handle HTTP routing, WebSocket upgrades, and webhook ingestion.
- **Durable Objects** give each agent instance a single-threaded, stateful process with hibernatable WebSocket connections.
- **Think framework** manages session lifecycle, context blocks, message history, and system prompt assembly.
- **Multiple sessions** are supported — each session maps to its own DO instance, addressable via `?session=<name>`.

---

## Platform capabilities (at a glance)

| Capability | What it does | Configuration | UI | REST API |
|------------|----------------|---------------|-----|----------|
| **Memory** | Context blocks (injected into system prompt) + per-session message history | Built-in Think session | **Memory** page | `/api/memory/*` |
| **Skills** | R2-backed instruction docs; model loads/unloads via `load_context` / `unload_context` | `SKILLS_BUCKET` + `ENABLE_SKILLS=true` | **Skills** page | `/api/skills/*` |
| **Browser Run** | Multi-step `browser_session` + one-shot `browser_execute` against real browsers | `browser` binding + Browser API token (see below) | **Chat** (tools) + **Settings** (CDP vs Puppeteer) | — |
| **Scheduled tasks** | Agent-created reminders: once, interval, or cron; DO-persisted | `schedule_task` / `list_tasks` / `cancel_task` tools | **Tasks** page | `/api/tasks/*` |
| **Worker cron** | Account-level cron invokes a full agent turn | `triggers.crons` in `wrangler.jsonc` + `scheduled` export | — | `POST /webhook/scheduled` (internal) |
| **Workflows** | Saved definitions + durable runs (research, page intel, promotion pipelines, …) | `workflows` bindings in `wrangler.jsonc` | **Workflows** page | `/api/workflows/*` |
| **MCP** | Connect remote MCP servers (e.g. Cloudflare Code Mode); tools flow into the agent | `ENABLE_MCP=true` + OAuth-capable browser for some servers | **Chat** (MCP panel) | `/api/mcp/*` |

Sub-agents (coder / tester / coordinator) and the promotion story are documented in [Sub-agents](#sub-agents-coder-tester-coordinator) and [docs/coding-platform-architecture.md](docs/coding-platform-architecture.md).

---

## Sub-agents (Coder, Tester, coordinator)

**What they are:** `CoderAgent` and `TesterAgent` are Think-based child agents used for the **manager ↔ coder ↔ tester** coding loop (patches, shared workspace, verification). They are **not** a separate chat product: end users still talk to **MainAgent** (Chat); MainAgent delegates coding work when the model and tools trigger that path.

**Canonical wiring (recommended):** bind **`SUBAGENT_COORDINATOR`** to the **`SubagentCoordinatorThink`** Durable Object in `wrangler.jsonc` (see migration `v6-subagent-coordinator`). Then production delegation is **MainAgent → coordinator DO → Coder / Tester** over `stub.fetch` + JSON. Without the binding, the Worker falls back to **MainAgent → `subAgent(Coder|Tester)`** for compatibility.

**Shared workspace:** collaboration uses **`SHARED_WORKSPACE_KV`** (and the same logical `sharedProjectId` surface) — see [coding-platform-architecture.md](docs/coding-platform-architecture.md) § *Sub-agent coding orchestration*.

**Coding loop → promotion (short version):** (1) **Coder** writes staging / `put_patch` into the shared workspace. (2) Data is stored in **`SHARED_WORKSPACE_KV`** (not R2). (3) **Tester** reads and verifies. (4) **Orchestrator** approve/apply (often inside the **coordinator** when running `runCodingCollaborationLoop`) updates patch **lifecycle in the same KV**. (5) **Promotion** (manifest write to **R2 / Artifacts**, release gate, deploy) is a **separate orchestrator step** — the loop does not auto-promote. Full step table: [coding-platform-architecture.md — *Coding loop vs promotion (end-to-end)*](docs/coding-platform-architecture.md#coding-loop-vs-promotion-end-to-end).

**Operator UI:** open the **Sub-Agents** page in the web app (same nav as Chat / Workflows). It shows health, optional **projects / tasks / run log** (requires **`COORDINATOR_CONTROL_PLANE_KV`** in `wrangler.jsonc`), and the same **HTTP / RPC debug probes** as the collapsible panel on Chat. Chat still has that panel for convenience.

**Debug HTTP harness (local / staging):** set `ENABLE_DEBUG_ORCHESTRATION_ENDPOINT=true` (and optional `DEBUG_ORCHESTRATION_TOKEN`), then e.g. `GET /api/debug/orchestrate?session=default&mode=success`. Coordinator smoke: `/api/debug/coordinator-chain`. More detail: [fixtures/sandbox-orchestration-micro/README.md](fixtures/sandbox-orchestration-micro/README.md).

**Deep dives (architecture and ops):**

| Doc | Purpose |
|-----|---------|
| [docs/coding-platform-architecture.md](docs/coding-platform-architecture.md) | Canonical vs legacy delegation, diagrams, promotion matrix, **coding loop vs promotion** table |
| [docs/agent-orchestration-boundaries.md](docs/agent-orchestration-boundaries.md) | Who may call what; coding loop topology |
| [docs/operator-live-readiness-checklist.md](docs/operator-live-readiness-checklist.md) | §8 coordinator + control-plane KV checklist |

---

## Memory System

The agent has two distinct kinds of memory that are completely independent of each other:

| | Context Blocks | Message History |
|---|---|---|
| What it is | Named text snippets | Conversation turns |
| Injected into system prompt | **Yes** — every turn | No |
| Persists across chats | **Yes** | Per-session only |
| Editable | Yes | Delete only |
| Cleared by "Clear history" | **No** | Yes |

### Context Blocks

A **context block** is a named, persistent chunk of text that is automatically injected into the agent's system prompt on every turn. Anything you write in a block is something the agent will always know and act on — across every conversation, forever, until you change it.

**How blocks work:**

1. You create or edit a block in the Memory page (or via the REST API).
2. On every agent turn, Think assembles the system prompt by concatenating all active blocks.
3. The agent reads the assembled prompt and behaves accordingly from that point forward.
4. Saving or deleting a block immediately triggers a **prompt refresh** so the change takes effect in the next turn.

---

### Block Label Reference

Labels are free-form strings — you can name a block anything. The following are recommended conventions with example content.

---

#### `preferences`
How the agent should communicate with you. Tone, format, verbosity.

```
- Always respond in concise bullet points unless I ask for detail.
- Use plain language. Avoid jargon.
- When giving code examples, prefer TypeScript.
- Never start responses with "Certainly!" or similar filler phrases.
- If I ask a yes/no question, lead with yes or no before explaining.
```

---

#### `user-profile`
Who you are. The agent uses this to tailor responses to your background and role.

```
Name: Your name
Role: Architect 
Expertise: Cloudflare, VoIP, AI/LLM integrations, Networking, Linux
Company: EdgeClaw Systems
Time zone: Central (US)
Experience level: Advanced — skip beginner explanations.
```

---

#### `workspace`
Your current project, repo, or work context. Update this as your focus shifts.

```
Current project: EdgeClaw — AI agent platform on Cloudflare Workers
Stack: TypeScript, Cloudflare Workers, Durable Objects, React + Vite
Repo: /path/to/your/EdgeClaw clone
Deployed to: https://edgeclaw-truth-agent.<your-subdomain>.workers.dev
Active sprint goal: Shipping the Memory management page and browser session tools.
```

---

#### `instructions`
Standing operational instructions the agent must always follow.

```
- Always ask before modifying files outside the current project directory.
- When writing TypeScript, always use strict types — never use `any`.
- Prefer editing existing files over creating new ones.
- After any code change, check for linter errors before finishing.
- Never commit to git unless I explicitly ask you to.
- When uncertain about requirements, ask one focused clarifying question.
```

---

#### `goals`
Long-term objectives the agent keeps in mind when making decisions.

```
Primary goal: Ship a production-ready, edge-native AI agent platform.
Design values: Simple, readable code over heavy abstraction.
Performance target: Sub-100ms agent response latency at the edge.
Quality bar: TypeScript strict mode, no any, no lint errors in main branch.
```

---

#### `constraints`
Hard limits and things the agent must never do.

```
- Never delete database records without explicit user confirmation.
- Never push to the main branch directly — always use a feature branch.
- Never expose API keys or secrets in logs, comments, or responses.
- Never use external npm packages without asking first.
- All Cloudflare Worker code must stay within the 10ms CPU budget per request.
```

---

#### `persona`
A custom character or voice for the agent to adopt.

```
You are a senior Cloudflare architect and TypeScript expert.
You are direct, precise, and practical. You prefer working code over theory.
You proactively flag potential issues before they become problems.
You ask one focused question at a time when clarification is needed.
```

---

#### `knowledge`
Domain knowledge, facts, or reference material the agent should internalize.

```
Cloudflare Durable Objects are single-threaded; never use shared mutable state.
The Think framework's Session class manages context blocks and message history.
Workers AI models available in this account: @cf/meta/llama-3.3-70b-instruct-fp8-fast
Browser Run quota: 10 concurrent sessions per account.
The Memory REST API base path is /api/memory — proxied from worker to DO.
```

---

#### `team`
Team members, roles, and relevant contacts.

```
You — Lead Engineer
Platform: Cloudflare Workers
Design system: Warm neutral palette, soft borders, no external UI libraries.
```

---

#### `projects`
A list of active projects and their current status.

```
CF_Truth agent platform — Active, in development
  Status: Memory page complete, browser sessions stable
  Next: Multi-agent routing, approval workflows

CloudflareBot automation — Parked
  Status: Reference implementation, not actively maintained
```

---

#### `notes`
Running notes, reminders, or things to revisit later.

```
- The browser executor defaults to CDP; Puppeteer is available as an alternative via Settings.
- Screenshots are JPEG quality 70 to stay under LLM context limits (~25-40KB each).
- Session param defaults to "default" — use ?session=name for multi-session memory isolation.
- The draftLabelRef pattern keeps the block editor from losing edits during server refreshes.
```

---

#### `shortcuts`
Custom aliases or abbreviations the agent should recognize.

```
"CF" always means Cloudflare, never California.
"DO" means Durable Object (Cloudflare), not just "do".
"Think" refers to @cloudflare/think, not the English word.
"the agent" refers to the MainAgent DO instance, not a generic concept.
"deploy" means `wrangler deploy` to the production worker.
```

---

#### `schedule`
Current deadlines, recurring events, or time-sensitive context.

```
Sprint ends: Friday EOD
Daily standup: 9:00 AM Central
Deployment window: Thursdays 3–5 PM only
Current blocker: Memory page REST API — in progress
```

---

#### `soul` *(reserved by Think framework)*  Configured in /src/agents/MainAgent.ts
The agent's core identity and values. This block is typically managed by the Think framework itself, but can be overridden here.

```
You are EdgeClaw — a capable, reliable AI agent running at the edge.
You help engineers build, debug, and ship software faster.
You are honest about uncertainty. You ask before assuming.
You prefer doing one thing well over doing many things poorly.
```

---

### Message History

Message history is the live conversation — the sequence of user, assistant, system, and tool messages from the current session. It is **separate from context blocks**:

- **Displayed** in the History tab with role badges, timestamps, and expand-in-place for long messages.
- **Filterable** by role (user, assistant, system, tool) and searchable by content.
- **Selectable** — check individual messages to delete specific ones without clearing all.
- **Clear history** wipes all messages but **never touches your memory blocks**.

---

### Memory REST API

All endpoints are served at `/api/memory` on the worker. Use `?session=<name>` to target a specific agent instance (defaults to `"default"`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory` | Full memory state: overview, all blocks, all messages |
| `PUT` | `/api/memory/:label` | Replace a block's content (creates if it doesn't exist) |
| `POST` | `/api/memory/:label/append` | Append text to an existing block |
| `DELETE` | `/api/memory/:label` | Delete a block permanently |
| `GET` | `/api/memory/search?q=` | Search blocks and messages by keyword |
| `POST` | `/api/memory/refresh-prompt` | Rebuild the agent's system prompt from current blocks |
| `POST` | `/api/memory/delete-messages` | Delete specific messages by ID array |
| `POST` | `/api/memory/clear-history` | Wipe all messages (blocks are not affected) |

**All mutating block endpoints** (`PUT`, `POST /:label/append`, `DELETE`) automatically call `refreshPrompt` after saving so the agent picks up the change on the next turn.

**Example — create or update a block:**
```bash
curl -X PUT https://edgeclaw-truth-agent.<your-subdomain>.workers.dev/api/memory/preferences \
  -H "Content-Type: application/json" \
  -d '{"content": "Always respond in bullet points."}'
```

**Example — target a specific session:**
```bash
curl "https://edgeclaw-truth-agent.<your-subdomain>.workers.dev/api/memory?session=research-agent"
```

---

### Memory Page UI

The **Memory** page in the frontend provides a full visual interface for managing agent memory.

**Blocks tab** — Two-column layout:
- Left sidebar lists all blocks with character counts, provider chips, and read-only badges.
- Right panel is a full editor with Save, Reset, Append, and Delete actions.
- Drafts are preserved locally until you explicitly Save or Reset — switching tabs or refreshing doesn't lose an in-progress edit.
- "New block" button opens an inline form with label + initial content fields. Duplicate label names are caught before submission.

**History tab** — Message table:
- Filter by role or search by content.
- Checkbox multi-select for bulk deletes.
- Expand-in-place for long messages.
- "Clear history" requires confirmation and explicitly states memory blocks are not affected.

**Advanced tab:**
- Collapsible raw JSON viewer of the full memory payload.
- Export to JSON file.
- Manual "Refresh prompt" button.
- Danger zone: clear all history with a second confirmation step.

---

## Session Skills

**Skills** are editable instruction documents stored in R2 and selectively injected into the agent's context window on demand. They let you package reusable behaviour — coding style guides, domain references, response templates — as named documents the model can load when it needs them rather than carrying them in every turn.

### How Skills Work

1. **Always visible as metadata** — On every turn, `R2SkillProvider.get()` renders a compact registry into the system prompt: each skill's key and one-sentence description. The model always knows what skills exist.
2. **Full content loaded on demand** — When the model decides it needs a skill, it calls the SDK tool `load_context("skills", "<key>")`. The full instruction text is fetched from R2 and appended to the active context for that turn.
3. **Freed after use** — The model calls `unload_context("skills", "<key>")` to release a skill when it is done. This keeps the context window lean across long conversations.
4. **Stored in R2** — Each skill is a JSON object in R2 with a key, name, description, tags, version counter, and content body. A summary copy is written as object metadata so the skills list can be fetched without downloading bodies.

The chat timeline shows compact inline rows whenever the agent loads or unloads a skill during a conversation:

```
────── 📄 Loaded skill: Code Reviewer ──────
```

### Skills vs Tools

| | Skills | Tools |
|---|---|---|
| **Purpose** | Passive instructions and context | Active executors of work |
| **Triggered by** | Model calling `load_context` | Model calling the tool function |
| **Effect** | Injects text into context window | Runs code / calls external APIs |
| **Stored in** | R2 | Defined in source code |
| **Examples** | Code style guide, persona doc, domain glossary | `browser_session`, `search`, `code_execute` |

Use skills when you want the model to *know* something; use tools when you want the model to *do* something.

### Configuring Skills

Skills require an R2 bucket and an environment flag. Both are already wired in the codebase — you just need to provision the bucket.

**Step 1 — Create the R2 bucket:**
```bash
wrangler r2 bucket create edgeclaw-truth-skills
```

**Step 2 — Verify the binding in `wrangler.jsonc`:**
```jsonc
"r2_buckets": [
  {
    "binding": "SKILLS_BUCKET",
    "bucket_name": "edgeclaw-truth-skills"
  }
]
```

**Step 3 — Enable the feature flag:**
```jsonc
"vars": {
  "ENABLE_SKILLS": "true"
}
```

**Step 4 — Deploy:**
```bash
npx wrangler deploy
```

If `SKILLS_BUCKET` is absent or `ENABLE_SKILLS` is `"false"`, the skills context block is silently skipped at session startup and no error is thrown. Everything else continues to work normally.

### Skills REST API

All endpoints are served at `/api/skills`. Use `?session=<name>` to target a specific agent instance.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/skills` | List all skills as summaries (no content bodies) |
| `GET` | `/api/skills/:key` | Fetch a single skill including full content |
| `POST` | `/api/skills` | Create a new skill |
| `PATCH` | `/api/skills/:key` | Partial update — name, description, content, or tags |
| `DELETE` | `/api/skills/:key` | Permanently delete a skill from R2 |

**Example — create a skill:**
```bash
curl -X POST https://edgeclaw-truth-agent.<your-subdomain>.workers.dev/api/skills \
  -H "Content-Type: application/json" \
  -d '{
    "key": "code-reviewer",
    "name": "Code Reviewer",
    "description": "Review code for correctness, style, and edge cases.",
    "content": "When asked to review code:\n- Check for type safety ...",
    "tags": ["code", "review"]
  }'
```

Skill keys must be lowercase, start with a letter or digit, and contain only letters, digits, hyphens, and underscores (validated both client-side and server-side).

### Skills UI

The **Skills** page in the frontend provides a full visual management interface:

- **Two-column layout** — sidebar list on the left, preview/editor pane on the right.
- **List** — compact skill cards showing name, description, tags, and last-updated date. An **"In session"** badge appears when the agent currently has a skill loaded in context.
- **Preview pane** — read-only view of the full instruction content with key, version, and tags.
- **Editor** — create and edit skills with key (auto-slugged from name on create), name, description, tags, and content fields.
- **Search and sort** — filter by name, description, or tag; sort by most recent or A–Z.
- **Inline timeline events** — the chat feed shows compact divider rows for every `load_context` / `unload_context` event so you can see exactly when and which skills the model uses.

---

## Browser Sessions

The `browser_session` tool gives the agent a persistent, multi-step browser controlled via **Cloudflare Browser Rendering / Browser Run** (remote browser + CDP or Puppeteer). Unlike a one-shot execute, a session survives across multiple LLM turns and supports human takeover at any point. One-shot navigation and scripting use the separate **`browser_execute`** / **`browser_search`** tools when `ENABLE_BROWSER_TOOLS` is enabled.

See [Cloudflare Browser Run (auth and bindings)](#cloudflare-browser-run-auth-and-bindings) for tokens and `wrangler.jsonc` wiring.

### Operations

| Operation | Description |
|-----------|-------------|
| `launch` | Start a new browser session, optionally with initial actions |
| `step` | Execute actions or a CDP script in an existing session |
| `resume` | Reconnect to a disconnected/active session and run a step |
| `resume_browser_session` | Reconnect and refresh without running new actions |
| `pause` | Transition to human-in-the-loop; leaves browser open |
| `complete` | Finalize the session with a summary and close the browser |
| `abandon` | Immediately close and discard the session |
| `status` | Read session state without any mutation |

### Structured Actions

Structured actions are the preferred way to drive the browser. They are readable, reliable, and don't require writing raw JavaScript.

| Action | Fields | Description |
|--------|--------|-------------|
| `navigate` | `url`, `waitUntil?` | Go to a URL. `waitUntil`: `load`, `domContentLoaded`, `networkIdle` |
| `click` | `selector`, `delayMs?` | Click a CSS selector |
| `type` | `selector`, `value`, `delayMs?`, `clearFirst?` | Type text into a field |
| `wait` | `selector?`, `timeoutMs?`, `waitUntil?` | Wait for an element or condition |
| `screenshot` | `fullPage?` | Capture the current viewport (JPEG, ~25–40 KB) |

**Example — search Amazon and screenshot results:**
```json
{
  "operation": "launch",
  "task": "Search for backpacks on Amazon",
  "actions": [
    { "type": "navigate", "url": "https://amazon.com" },
    { "type": "type", "selector": "input#twotabsearchtextbox", "value": "backpacks" },
    { "type": "click", "selector": "button[type=submit]" },
    { "type": "wait", "selector": ".s-result-item", "timeoutMs": 5000 },
    { "type": "screenshot", "fullPage": false }
  ]
}
```

**Example — continue to the next page:**
```json
{
  "operation": "step",
  "sessionId": "<session-id>",
  "actions": [
    { "type": "click", "selector": ".a-pagination .a-last" },
    { "type": "wait", "selector": ".s-result-item", "timeoutMs": 5000 },
    { "type": "screenshot" }
  ]
}
```

### Execution Strategies

The browser tool supports two execution backends that can be switched without code changes:

| Strategy | Description | Default |
|----------|-------------|---------|
| `cdp` | Chrome DevTools Protocol — direct, low-level, maximum control | **Yes** |
| `puppeteer` | Puppeteer-over-CDP — higher-level API, easier for complex interactions | No |

**Switching the strategy:**
- Go to **Settings** in the frontend and toggle between CDP and Puppeteer.
- The change takes effect on the next browser session launch.
- Existing sessions are not affected by mid-session strategy changes.

**Why two strategies?** CDP is lower overhead and more direct; Puppeteer is easier for complex multi-frame pages, file uploads, and dialog handling. Keeping both lets you choose per-task without deploying code changes.

### Human-in-the-Loop (HITL)

Any browser session can be paused to hand control to a human:

```json
{
  "operation": "pause",
  "sessionId": "<session-id>",
  "humanInstructions": "Please complete the login and press OK when done."
}
```

The session stays alive (using `reusable` mode with `keepAliveMs`), the browser remains open, and the agent waits. When you're done, the agent can `resume` where it left off.

**Useful for:**
- Sites with CAPTCHAs or MFA
- Approval gates before destructive actions
- Manual data entry that's faster done by hand
- Reviewing a page before the agent continues

**Auto-pause on blockers** — Launch with `pauseForHumanOnBlocker: true` and the agent will automatically pause if it detects a login wall or CAPTCHA, then hand off to you rather than failing.

---

## Cloudflare Browser Run (auth and bindings)

Browser automation uses Cloudflare’s **Browser** binding and the **Browser Run** HTTP/WebSocket APIs from inside the Worker / DO.

**`wrangler.jsonc`**

- `browser.binding` → typically **`BROWSER`** (must match `MainAgent` / env types).
- Worker vars: **`CLOUDFLARE_ACCOUNT_ID`**, and a Browser-capable API token.

**Tokens (production pattern)**

- Prefer **`CLOUDFLARE_BROWSER_API_TOKEN`** scoped for Browser Rendering / Browser Run when that token type is available.
- Otherwise **`CLOUDFLARE_API_TOKEN`** may be used if it has the right permissions.
- At startup, **MainAgent** logs which source was selected (`CLOUDFLARE_BROWSER_API_TOKEN` vs `CLOUDFLARE_API_TOKEN`) and fingerprints (not raw secrets) for debugging token mix-ups.

**Feature flags**

- **`ENABLE_BROWSER_TOOLS`** — enables **`browser_search`** / **`browser_execute`** style tools (string `true` in `wrangler.jsonc` `vars`).
- Session tool availability is gated separately in code paths that wire **`BrowserSessionManager`**; if the Browser binding or account/token pair is invalid, session launch fails with explicit configuration errors in logs.

**Executor choice**

- Per-session **CDP** vs **Puppeteer** is chosen from the **Settings** UI and sent on each chat turn; see [Execution strategies](#execution-strategies) above.

---

## Scheduled tasks and worker cron

### Agent-scheduled tasks (DO-persisted)

The agent can create **named, persisted tasks** that run **instructions** on a schedule you define in natural language through tools:

| Tool | Purpose |
|------|---------|
| **`schedule_task`** | Create a task: **once** at an ISO datetime, **interval** (e.g. every N minutes), or **cron** (5-field expression, e.g. weekdays 9:00). |
| **`list_tasks`** | List tasks and metadata (ids, schedule, next run). |
| **`cancel_task`** | Remove a task by id (confirm with the user before calling). |

Tasks are stored on the **MainAgent** Durable Object for the session. The system prompt reminds the model not to claim a task was scheduled until **`schedule_task`** returns success.

**REST API** — proxied at **`/api/tasks`** on the worker (`?session=` supported like memory):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tasks` | List all persisted tasks |
| `POST` | `/api/tasks` | Create a task |
| `PATCH` | `/api/tasks/:id` | Partial update |
| `DELETE` | `/api/tasks/:id` | Delete |
| `POST` | `/api/tasks/:id/toggle` | Enable / pause |

**UI** — **Tasks** page in the main nav: view, create, edit, pause, and delete tasks outside of chat if you prefer.

### Worker-level cron (`scheduled` export)

**Account cron** is configured in **`wrangler.jsonc`** under **`triggers.crons`** (example: `"0 6 * * *"` for 06:00 UTC daily). The Worker’s **`scheduled`** handler builds a **`WebhookPayload`** and runs the same **`dispatchTurn`** path as HTTP webhooks so a full agent turn runs (tools, MCP, etc.) with metadata like `{ "source": "cron", "cron": "<expression>" }`.

**`POST /webhook/scheduled`** — same JSON body shape as **`POST /webhook/trigger`**; reserved for parity or external schedulers calling your worker directly.

---

## Workflows (definitions and runs)

**Workflows** are first-class **definitions + runs** backed by **Cloudflare Workflows** bindings and KV persistence inside **MainAgent**.

**Bindings (`wrangler.jsonc`)** — each entry registers a durable workflow class used when a definition’s **binding** matches, for example:

- `EDGECLAW_RESEARCH_WORKFLOW` → `EdgeclawResearchWorkflow`
- `EDGECLAW_PAGE_INTEL_WORKFLOW` → `EdgeclawPageIntelWorkflow`
- `EDGECLAW_PREVIEW_PROMOTION_WORKFLOW` → `EdgeclawPreviewPromotionWorkflow`
- `EDGECLAW_PRODUCTION_DEPLOY_WORKFLOW` → `EdgeclawProductionDeployWorkflow`

Definitions can use trigger modes such as **manual**, **scheduled**, or **event** (see `workflowPersistence` types). The agent can **launch** workflows from tools when wired; the **Workflows** UI is the primary place to author definitions, launch runs, inspect status, approve/reject where applicable, and terminate or resume runs.

**REST API** — **`/api/workflows`** (worker strips `/api`; DO sees `/workflows/...`):

- **Definitions:** `GET/POST /api/workflows`, `PATCH/DELETE /api/workflows/:id`, `POST /api/workflows/:id/toggle`, `POST /api/workflows/:id/launch`
- **Runs:** `GET /api/workflows/runs`, `GET /api/workflows/runs/:runId`, `POST .../terminate`, `.../resume`, `.../restart`, `.../approve`, `.../reject`, `.../event`

**UI** — **Workflows** page in the main nav lists definitions and runs and exposes launch/abort/resume actions aligned with the REST surface.

---

## MCP (Model Context Protocol)

**MCP** lets **MainAgent** connect to remote MCP servers (Streamable HTTP or compatible transports). Discovered tools, prompts, and resources are merged into the agent’s tool surface when a server is **connected** and **enabled**.

**Configuration**

- Set **`ENABLE_MCP=true`** in `wrangler.jsonc` `vars` for production MCP wiring.
- Servers are added with URL, optional headers, and transport; state is persisted on the DO and restored after hibernation.

**REST API** — **`/api/mcp`** (proxied to the DO as `/mcp/...`):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mcp` | Full discovery snapshot (servers, tools, lifecycle, auth hints) |
| `POST` | `/api/mcp/add` | Connect a new server |
| `POST` | `/api/mcp/remove` | Remove a server by name |
| `POST` | `/api/mcp/reconnect` | Reconnect after failure |

**OAuth / browser flows** — Some MCP servers require OAuth. **MainAgent** configures an OAuth callback suitable for **popup-close** behavior; completing auth in a real browser session may be required once per server.

**Sub-agents** — **CoderAgent** / **TesterAgent** facets intentionally **do not** run the full MainAgent MCP OAuth / browser / TTS restore path; orchestration uses shared workspace tools instead. See [Sub-agents](#sub-agents-coder-tester-coordinator).

**UI** — Chat surfaces MCP connection status and discovery; use **`GET /api/mcp`** or the in-app MCP controls to add/remove/reconnect servers.

---

## Getting Started

**New deployers:** read **[First-time deployment checklist](#first-time-deployment-checklist-must-haves-vs-optional)** (must-have `wrangler` vars, bindings, and secrets/API tokens) before your first `wrangler deploy`.

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account with **Workers**, **Durable Objects**, **Browser Rendering** (Browser Run), **AI** (Workers AI and/or AI Gateway), and optionally **Workflows**, **R2**, and **KV** per your `wrangler.jsonc` bindings

### Install

```bash
# Install worker dependencies
npm install

# Install frontend dependencies
cd frontend && npm install && cd ..
```

### Develop locally

```bash
# Start the worker (with local DO emulation)
npx wrangler dev

# In a separate terminal — start the frontend dev server
cd frontend && npm run dev
```

### Deploy

```bash
# Build and deploy the worker
npx wrangler deploy

# Build the frontend (Wrangler uploads assets automatically if ASSETS binding is configured)
cd frontend && npm run build
```

### Wrangler and secrets (public repo / local overrides)

The committed **`wrangler.jsonc`** is an **account-agnostic template** (`YOUR_*` / `__REPLACE_*` placeholders, optional bindings commented out). For your own Cloudflare account:

1. Copy it to **`wrangler.local.jsonc`** (that filename is **gitignored**), replace placeholders with your **account ID**, **AI Gateway** `/compat` base URL, **R2** bucket names, and uncomment or add **`kv_namespaces`** after `wrangler kv namespace create …` / `wrangler kv namespace list`.
2. Deploy with **`npx wrangler deploy --config wrangler.local.jsonc`** (and `wrangler dev --config wrangler.local.jsonc` for local runs). Keep the default **`wrangler.jsonc`** as the shared “production template” for forks; use **`--config`** for staging or personal wiring without leaking IDs into Git.
3. Put real tokens in **Wrangler secrets** (`wrangler secret put …`) or **`.dev.vars`** for local dev — not in JSON.

### First-time deployment checklist (must-haves vs optional)

Use this when bringing up **your own** Cloudflare account. Anything marked **required** will block a working agent or cause startup errors; the rest unlocks specific features.

#### Cloudflare account & Wrangler

- **Required:** A Cloudflare account with **Workers** and **Durable Objects** enabled (the default template binds **`MAIN_AGENT`** and related DOs; migrations ship with the repo).
- **Required:** Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/) and run **`wrangler login`** once so deploys and `secret put` target the right account.
- **Required for this template’s bindings:** **Workers AI** (`ai` binding), **Browser Rendering / Browser Run** (`browser` binding), **R2** (two buckets), **static assets** (`./frontend/dist`), **Worker Loaders** (`worker_loaders`). These are declared in **`wrangler.jsonc`** — Wrangler will fail the deploy if your account cannot satisfy a binding (e.g. missing product access).
- **Workflows:** The repo registers **four** workflow classes. Your account needs the **Workflows** product if you rely on the Workflows UI/API; otherwise adjust bindings or expect errors only on workflow-related routes.
- **Optional KV:** **`SHARED_WORKSPACE_KV`** and **`COORDINATOR_CONTROL_PLANE_KV`** are **not** in the committed template by default. Add **`kv_namespaces`** (with real namespace IDs) when you want shared Coder/Tester workspace persistence and the **Sub-Agents** control-plane UI (projects / tasks / runs). Without them, core chat and delegation can still work with fallbacks.

#### Plain configuration (`vars` + resource names in `wrangler.jsonc` / `wrangler.local.jsonc`)

These are **not** secrets — they are deployed as **plain vars** or binding metadata on every `wrangler deploy`.

| Item | Required? | Notes |
|------|-------------|--------|
| **`CLOUDFLARE_ACCOUNT_ID`** | **Yes** | 32-character hex from the dashboard URL / account home. Used at runtime (e.g. Browser Run, gateway log proxy, optional Workers API calls). |
| **`AI_GATEWAY_BASE_URL`** | **Yes** | Must be the OpenAI-compatible **`…/compat`** URL for your [AI Gateway](https://developers.cloudflare.com/ai-gateway/). The worker **throws at startup** if this is missing or does not end with `/compat`. |
| **R2 bucket names** (`changeme-edgeclaw-*` in the template) | **Yes** if `ENABLE_SKILLS` / promotion paths are on | Create buckets with **`wrangler r2 bucket create …`**, then set the same names under **`r2_buckets`** and **`PROMOTION_ARTIFACTS_BUCKET_NAME`** (must match the promotion bucket). |
| **`ENABLE_SKILLS`** + **`SKILLS_BUCKET`** | Strongly recommended | If `ENABLE_SKILLS=true` but the R2 binding is missing, session skills are disabled (warning only). Set **`ENABLE_SKILLS=false`** if you intentionally skip skills. |
| **`ENVIRONMENT`** | No | `development` / `staging` / `production` — telemetry and behavior hints. |
| Other `vars` (`ENABLE_MCP`, `ENABLE_BROWSER_TOOLS`, …) | No | Feature toggles; see inline comments in **`wrangler.jsonc`** and the [Browser Run](#cloudflare-browser-run-auth-and-bindings) section. |

#### Secrets & API tokens (never commit — `.dev.vars` + `wrangler secret put`)

**GitHub pushes do not update the Worker** and do **not** rotate Cloudflare-stored secrets. Set secrets once per Worker (or use **`npm run secrets`**, which reads **`.dev.vars`** and runs `wrangler secret put` for each non-empty line — see **`.dev.vars.example`**).

| Secret / token | When you need it |
|----------------|------------------|
| **`OPENAI_API_KEY`** / **`ANTHROPIC_API_KEY`** | When your model traffic uses those providers (typical for LLM calls through AI Gateway, depending on provider configuration). |
| **`AI_GATEWAY_TOKEN`** | When your AI Gateway is configured to require a bearer token on requests. |
| **`CLOUDFLARE_API_TOKEN`** and/or **`CLOUDFLARE_BROWSER_API_TOKEN`** | **Browser Run / `browser_search` / `browser_execute`** paths need a token with Browser Rendering (and related) permissions. Prefer a dedicated **`CLOUDFLARE_BROWSER_API_TOKEN`** when you use one; otherwise a sufficiently scoped **`CLOUDFLARE_API_TOKEN`**. See [Browser Run](#cloudflare-browser-run-auth-and-bindings). |
| **`CLOUDFLARE_API_TOKEN`** (again) | **Only** if you enable optional features that call the Workers API from the Worker (e.g. preview/production deploy **witness** or **preview Worker version upload** — see comments in **`wrangler.jsonc`** and `docs/preview-deploy-cloudflare.md`). Not required for basic chat. |
| **`MCP_SERVER_URL`** / **`MCP_AUTH_TOKEN`** | Optional; when using remote MCP servers (`ENABLE_MCP=true`). |
| **`DEBUG_ORCHESTRATION_TOKEN`** / **`SUBAGENT_REPRO_TOKEN`** | Optional hardening for debug/repro HTTP routes when those endpoints are left enabled. Do **not** duplicate `ENABLE_*` flags here — those stay as plain `vars`. |

**Wrangler deploy vs secrets:** `wrangler deploy` applies **code + plain `vars` + bindings**. **Secrets** live separately in Cloudflare; redeploying does **not** wipe them. Do not put API keys in **`wrangler.jsonc`** — use **`.dev.vars`** locally and **`wrangler secret put`** (or **`npm run secrets`**) for deployed Workers.

#### Before `wrangler deploy`

1. **`cd frontend && npm run build`** so **`./frontend/dist`** exists (static **ASSETS** upload).
2. Replace all **`__REPLACE_*`**, **`YOUR_*`**, and the **`changeme`** R2 prefix (or create buckets with those literal names for a throwaway test).
3. **`cp .dev.vars.example .dev.vars`**, fill values, then **`npx wrangler dev`** (reads `.dev.vars`) or **`npm run secrets`** then **`npx wrangler deploy`** for production.

---

## Project Structure

```
CF_Truth/
├── src/
│   ├── server.ts                  # Worker entry point — HTTP routing, WebSocket, webhooks
│   ├── agents/
│   │   ├── MainAgent.ts                 # Root agent — model routing, tools, memory bridge, onRequest
│   │   ├── SubagentCoordinatorThink.ts  # Optional DO — canonical parent for Coder/Tester delegation
│   │   └── subagents/                   # CoderAgent, TesterAgent, ResearchAgent, ExecutionAgent
│   ├── api/
│   │   ├── memoryRoutes.ts        # Memory REST route handler (DO-level)
│   │   ├── skillsRoutes.ts        # Skills REST route handler (DO-level)
│   │   ├── tasksRoutes.ts         # Scheduled tasks REST (DO-level)
│   │   ├── workflowsRoutes.ts     # Workflows definitions + runs REST (DO-level)
│   │   └── mcpRoutes.ts           # MCP discovery + add/remove/reconnect (DO-level)
│   ├── skills/
│   │   ├── SkillStore.ts          # R2-backed skill persistence — list, get, create, update, delete
│   │   └── types.ts               # Backend skill types (SkillDocument, SkillSummary, …)
│   ├── session/
│   │   └── configureSession.ts    # Session setup — context blocks, skills, compaction
│   ├── browserSession/
│   │   ├── BrowserSessionManager.ts   # Session lifecycle — launch, step, pause, resume, complete
│   │   ├── providerAdapter.ts         # CDP / Puppeteer execution strategy abstraction
│   │   └── cloudflareBrowserRunApi.ts # Cloudflare Browser Run API auth + WebSocket
│   ├── workflows/                 # EdgeclawResearchWorkflow, PageIntel, PreviewPromotion, ProductionDeploy
│   ├── tools/
│   │   ├── browserSession.ts      # browser_session AI tool definition and execute handler
│   │   └── browser.ts             # browser_execute (one-shot) tool
│   ├── models/
│   │   └── index.ts               # ModelRouter — dynamic model selection per task
│   └── lib/
│       ├── env.ts                 # Cloudflare env bindings + runtime config
│       └── observability.ts       # Logging and tracing
│
├── frontend/
│   └── src/
│       ├── App.tsx                # Root component — navigation, page routing
│       ├── pages/
│       │   ├── ChatPage.tsx       # Chat transcript, streaming, context event timeline rows
│       │   ├── MemoryPage.tsx     # Memory management page (blocks + history + advanced)
│       │   ├── SkillsPage.tsx     # Skills management page — list, preview, create, edit
│       │   ├── TasksPage.tsx      # Scheduled tasks — list, create, toggle, delete
│       │   ├── WorkflowsPage.tsx  # Workflow definitions + runs
│       │   └── SubAgentsPage.tsx  # Coordinator control plane — health, registry, debug probes
│       ├── components/
│       │   ├── chat/              # AssistantTurnCard, ContextEventRow, activity timeline, …
│       │   ├── memory/            # Overview cards, block editor, search bar, …
│       │   └── skills/            # SkillRow (card), SkillDrawer (preview + editor pane)
│       ├── lib/
│       │   ├── agentClient.ts     # WebSocket agent client — streaming, tool events, RPC
│       │   ├── memoryApi.ts       # Type-safe HTTP client for /api/memory endpoints
│       │   ├── skillsApi.ts       # Type-safe HTTP client for /api/skills endpoints
│       │   ├── tasksApi.ts        # Type-safe HTTP client for /api/tasks endpoints
│       │   ├── workflowsApi.ts    # Type-safe HTTP client for /api/workflows endpoints
│       │   ├── mcpApi.ts          # Type-safe HTTP client for /api/mcp endpoints
│       │   └── loadedSkillKeys.ts # Pure helper — derives loaded-skill set from timeline events
│       ├── types/
│       │   ├── memory.ts          # TypeScript types for memory blocks, messages, API shapes
│       │   └── skills.ts          # TypeScript types for skill documents, summaries, API shapes
│       └── styles.css             # Design system — warm neutral palette, all page classes
│
└── wrangler.jsonc                 # Cloudflare deployment config — bindings, DO, R2, assets
```
