Add a human-in-the-loop approval mechanism to the prototype.

Use case:
- sensitive actions or high-risk outputs must pause for approval
- examples:
  - anything involving policy changes
  - vendor communication drafts
  - executive-facing summaries with low confidence
  - any proposed action that could affect production systems

Please generate:
1. approval state model
2. workflow pause/resume integration
3. API endpoints for approve/reject
4. placeholder UI response shapes
5. example approval record persisted to R2
6. comments on how to wire this into a future web UI or chat platform

Keep this prototype-safe and explicit.