You are my senior TypeScript architect.

I want to build a Cloudflare-native agent prototype using:
- Cloudflare Agents SDK
- Durable Objects
- Cloudflare AI Gateway with multiple routes
- R2
- Workflows
- optional Browser Rendering
- optional Dynamic Workers later

Goal:
Build a working prototype of an enterprise-style agent system inspired by OpenClaw patterns, but implemented natively on Cloudflare.

Constraints:
- TypeScript only
- no Python
- use current Cloudflare Agents SDK patterns
- prefer simple, readable architecture
- no over-engineering
- keep everything prototype-friendly
- include comments where useful
- do not invent APIs if unsure; flag uncertainty inline

Please generate:
1. a proposed folder structure
2. a short architecture explanation
3. a build plan in phases
4. a list of required Cloudflare bindings and resources
5. a wrangler.jsonc or wrangler.toml starter config
6. the minimal package.json dependencies

Architecture intent:
- Dispatcher agent classifies incoming requests
- Analyst agent handles read/analyze/recommend tasks
- Drafting agent creates summaries and reports
- Audit agent reviews outputs for accuracy/risk
- Durable Objects coordinate active tasks
- R2 stores worklogs, artifacts, and long-term memory
- Workflows run durable multi-step jobs
- Browser Rendering is reserved for UI-only systems
- Dynamic Workers are reserved for isolated generated code execution

Please keep the first deliverable concise but production-minded.