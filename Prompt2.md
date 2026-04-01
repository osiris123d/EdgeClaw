Using the architecture we agreed on, generate a minimal but working Cloudflare project structure with these components:

- src/index.ts
- src/agents/DispatcherAgent.ts
- src/agents/AnalystAgent.ts
- src/agents/DraftingAgent.ts
- src/agents/AuditAgent.ts
- src/durable/TaskCoordinatorDO.ts
- src/durable/QueueDO.ts
- src/workflows/TaskWorkflow.ts
- src/lib/r2.ts
- src/lib/task-schema.ts
- src/lib/worklog.ts
- src/lib/prompts.ts
- src/lib/types.ts

Requirements:
- TypeScript
- use Cloudflare-native patterns
- define clear interfaces and types
- include TODO markers where implementation depends on credentials or external APIs
- do not build browser rendering or dynamic workers yet
- keep the design modular and easy to evolve

For each file:
- include full code
- include a brief header comment explaining the file’s role
- prefer explicit types over magic
- include basic error handling

Important:
This prototype is for an OpenClaw-style planning/task/audit system on Cloudflare, not a generic chatbot.