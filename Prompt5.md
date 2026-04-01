Implement a Cloudflare Durable Object called TaskCoordinatorDO for coordinating a single task.

Responsibilities:
- own the active state for one task
- prevent concurrent conflicting execution
- track current status
- track retry count
- track heartbeat timestamp
- track approval state
- expose methods to:
  - initialize task
  - acquire lease
  - renew heartbeat
  - complete step
  - fail step
  - pause for approval
  - resume after approval
  - mark task complete

Also implement a simple QueueDO for task queueing by lane:
- incident-triage
- change-review
- reporting

Please generate:
1. full TypeScript code
2. request/response method interfaces
3. minimal internal persistence strategy
4. examples of how Agents or Workflows would call into these DOs
5. comments explaining why this is per-task/per-queue rather than one giant singleton object

Keep it pragmatic and prototype-ready.