Create strongly typed TypeScript schemas and interfaces for the core task system.

I need these entities:
- TaskPacket
- WorklogEntry
- AuditResult
- TaskStatus
- TaskType
- DomainType
- ApprovalState
- ArtifactReference
- AgentRole

Desired task types:
- incident_triage
- change_review
- report_draft
- exec_summary
- vendor_followup
- root_cause_analysis

Desired domains:
- wifi
- nac
- ztna
- telecom
- content_filtering
- cross_domain

TaskPacket must include:
- taskId
- taskType
- domain
- title
- goal
- definitionOfDone
- allowedTools
- forbiddenActions
- inputArtifacts
- dependencies
- status
- approvalState
- escalationRules
- createdAt
- updatedAt
- assignedAgentRole
- metadata

Please:
1. create the TypeScript types/interfaces
2. create example objects
3. add validation helpers
4. keep it Cloudflare/Workers compatible
5. avoid external validation libraries unless absolutely necessary