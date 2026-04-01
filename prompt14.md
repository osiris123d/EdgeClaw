Add an optional Dynamic Worker execution path for isolated generated code.

Important:
- this should NOT be used for ordinary API calls
- this is only for:
  - generated validation scripts
  - custom data transforms
  - isolated diagnostics
  - semi-trusted code execution

Please generate:
1. a DynamicWorkerTask interface
2. an execution wrapper abstraction
3. a risk policy comment block explaining when to use this path vs normal tools
4. a placeholder implementation that can be expanded later
5. example use case:
   - validate a proposed network-change rollout plan using generated logic

Keep this modular and clearly separated from the normal tool path.