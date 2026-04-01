Implement an R2 storage helper module for this agent system.

I want an opinionated key structure like:

org/hilton/
  tasks/{taskId}/task.json
  tasks/{taskId}/worklog/{entryId}.json
  tasks/{taskId}/artifacts/{name}
  incidents/{incidentId}/summary.json
  reports/{reportId}/draft.md
  knowledge/{domain}/{category}/{file}
  users/{userId}/profile.json

Please generate:
1. a TypeScript R2 helper module
2. functions for:
   - putTask
   - getTask
   - appendWorklogEntry
   - listWorklogEntries
   - putArtifact
   - getArtifact
   - listArtifacts
   - saveKnowledgeDoc
   - loadKnowledgeDoc
3. helper functions to consistently generate keys
4. comments on how prefix-based organization works in R2
5. examples of usage inside a Worker

Requirements:
- use Cloudflare R2 binding patterns
- serialize JSON safely
- include defensive error handling
- keep it simple and clean
- do not assume folders are real; use object key prefixes properly