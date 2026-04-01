Implement a DraftingAgent using the Cloudflare Agents SDK.

Purpose:
- draft executive summaries
- weekly reports
- CAB notes
- vendor follow-up drafts
- leadership updates

Requirements:
- input comes from TaskPacket + prior analysis outputs
- preserve technical accuracy
- keep business language concise
- never send anything externally
- output should be markdown plus structured metadata
- append a worklog entry after drafting

Please generate:
1. full agent class
2. prompt templates for:
   - exec summary
   - weekly report
   - CAB note
3. output schema
4. example markdown output
5. comments showing where approval gates would be inserted