Implement a Cloudflare Workflow for durable multi-step task execution.

Goal:
Create a TaskWorkflow that:
1. loads the task
2. calls AnalystAgent if analysis is needed
3. calls DraftingAgent if drafting is needed
4. calls AuditAgent
5. pauses if approval is required
6. resumes after approval
7. writes final status to R2 and TaskCoordinatorDO

Requirements:
- use durable workflow step patterns
- support retries
- support progress reporting back to the agent
- keep each step small and explicit
- include comments explaining what belongs in Workflows vs Agents vs Durable Objects

Please generate:
1. full workflow code
2. starter invocation example
3. explanation of failure handling
4. explanation of approval pause/resume design