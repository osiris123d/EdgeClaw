Implement an AuditAgent using the Cloudflare Agents SDK.

Purpose:
- review AnalystAgent or DraftingAgent output
- identify unsupported claims
- identify missing evidence
- identify overconfidence
- identify risky recommendations
- recommend:
  - accept
  - revise
  - escalate to human

Requirements:
- compare output against the task packet, source artifacts, and worklog
- do not rewrite the content unless asked
- produce a structured AuditResult
- append audit findings to the worklog

Please generate:
1. full agent class code
2. audit prompt template
3. AuditResult interface if needed
4. examples of good vs bad findings
5. guidance for keeping this idempotent and repeatable