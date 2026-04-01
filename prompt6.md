Implement a DispatcherAgent using the Cloudflare Agents SDK.

Purpose:
- receive incoming chat or API requests
- classify the request into a task type and domain
- create a TaskPacket
- store the task in R2
- initialize coordination in TaskCoordinatorDO
- enqueue it in QueueDO
- optionally start a Workflow

Input examples:
- "Review this NAC policy change and draft CAB notes"
- "Summarize this WiFi outage for leadership"
- "Create my weekly network report draft"
- "Analyze a ZTNA access problem from these notes"

Requirements:
- classify using deterministic rules first, AI second
- produce a confidence score
- if confidence is low, mark for human review
- return a structured response
- log the routing decision to the worklog

Please generate:
1. agent class code
2. classification helper logic
3. prompt template for LLM-assisted classification
4. sample request/response payloads
5. explanation of where to put future connectors like Teams/Discord/web UI