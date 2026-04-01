Add a browser automation integration layer for future use.

Important:
- do not fully implement vendor-specific automation yet
- instead create an abstraction layer for browser tasks
- intended future use cases:
  - interact with portals that lack APIs
  - gather screenshots
  - navigate internal web tools
  - collect evidence for analysis

Please generate:
1. a browser task interface
2. a service abstraction for Cloudflare Browser Rendering
3. example task types:
   - capture_page_summary
   - collect_screenshot
   - extract_table_data
4. comments on how this should be approval-gated for sensitive systems
5. a placeholder implementation that compiles