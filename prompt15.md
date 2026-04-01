Create an idempotent structured test harness for this prototype.

I want:
- unit tests for task classification
- unit tests for R2 key generation
- unit tests for worklog formatting
- unit tests for approval-state transitions
- integration-style tests for TaskWorkflow orchestration
- mocks/stubs for Cloudflare bindings where needed

Requirements:
- keep tests deterministic
- avoid snapshot spam
- prefer explicit assertions
- include comments for how to expand later
- do not overbuild test abstractions

Please generate:
1. test strategy
2. test file structure
3. actual test code
4. helper mocks for env bindings