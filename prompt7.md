Implement an AnalystAgent using the Cloudflare Agents SDK.

Purpose:
- perform read/analyze/recommend work only
- no production changes
- no external sends
- no destructive actions

Outputs may include:
- incident timelines
- impact summaries
- root cause hypotheses
- risk analysis
- next-step recommendations
- technical notes

Requirements:
- input is a TaskPacket plus related artifacts and worklog entries
- agent must append a structured worklog entry after each run
- clearly separate facts, assumptions, and recommendations
- if confidence is low, explicitly flag uncertainty
- keep outputs structured and auditable

Please generate:
1. agent class code
2. analysis prompt template
3. structured output format
4. helper functions for worklog creation
5. example result for a WiFi/NAC incident task