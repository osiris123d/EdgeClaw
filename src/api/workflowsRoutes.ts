/**
 * workflowsRoutes.ts
 *
 * DO-level HTTP handler for all /workflows/* routes.
 *
 * Called from MainAgent.onRequest() after the worker-level proxy in server.ts
 * strips /api and forwards requests here.  Route table:
 *
 *   Definitions:
 *     GET    /workflows                            → WorkflowDefinitionsListResponse
 *     POST   /workflows                            → WorkflowDefinitionApiResponse  (201)
 *     PATCH  /workflows/:id                        → WorkflowDefinitionApiResponse
 *     DELETE /workflows/:id                        → 204 No Content
 *     POST   /workflows/:id/toggle                 → WorkflowDefinitionApiResponse
 *     POST   /workflows/:id/launch                 → WorkflowRunApiResponse         (201)
 *
 *   Runs:
 *     GET    /workflows/runs                       → WorkflowRunsListResponse
 *     GET    /workflows/runs/:runId                → WorkflowRunApiResponse
 *     POST   /workflows/runs/:runId/terminate      → WorkflowRunApiResponse
 *     POST   /workflows/runs/:runId/resume         → WorkflowRunApiResponse
 *     POST   /workflows/runs/:runId/restart        → WorkflowRunApiResponse  (201)
 *     POST   /workflows/runs/:runId/approve        → WorkflowRunApiResponse
 *     POST   /workflows/runs/:runId/reject         → WorkflowRunApiResponse
 *     POST   /workflows/runs/:runId/event          → WorkflowRunApiResponse
 *
 * ── Adapter pattern ───────────────────────────────────────────────────────────
 *
 * WorkflowRouteAdapter is the interface MainAgent implements.  There is no
 * circular import: MainAgent passes `this as unknown as WorkflowRouteAdapter`
 * to handleWorkflowRoute().  TypeScript validates the cast structurally.
 */

import type {
  PersistedWorkflowDefinition,
  PersistedWorkflowRun,
  WorkflowDefinitionApiResponse,
  WorkflowRunApiResponse,
  WorkflowDefinitionsListResponse,
  WorkflowRunsListResponse,
  CreateWorkflowDefinitionInput,
  UpdateWorkflowDefinitionInput,
} from "../lib/workflowPersistence";

// Re-export so callers can import from a single place.
export type {
  PersistedWorkflowDefinition,
  PersistedWorkflowRun,
  WorkflowDefinitionApiResponse,
  WorkflowRunApiResponse,
  WorkflowDefinitionsListResponse,
  WorkflowRunsListResponse,
  CreateWorkflowDefinitionInput,
  UpdateWorkflowDefinitionInput,
};

// ── Adapter interface ─────────────────────────────────────────────────────────
//
// MainAgent implements every method below via its workflow persistence layer
// and the workflowRuntime adapter.

export interface WorkflowRouteAdapter {
  // ── Definitions ────────────────────────────────────────────────────────────

  /** Return all saved definitions, newest first. */
  listWorkflowDefinitions(): Promise<PersistedWorkflowDefinition[]>;

  /** Return one definition by ID, or null if missing. */
  getWorkflowDefinition(id: string): Promise<PersistedWorkflowDefinition | null>;

  /** Create and persist a new definition. */
  createWorkflowDefinition(input: CreateWorkflowDefinitionInput): Promise<PersistedWorkflowDefinition>;

  /**
   * Apply a partial update to an existing definition.
   * Throws "not found" if the id is unknown.
   */
  updateWorkflowDefinition(id: string, patch: UpdateWorkflowDefinitionInput): Promise<PersistedWorkflowDefinition>;

  /**
   * Delete a definition and all associated run records.
   * Throws "not found" if the id is unknown.
   */
  deleteWorkflowDefinition(id: string): Promise<void>;

  /**
   * Enable or disable a definition.
   * Throws "not found" if the id is unknown.
   */
  toggleWorkflowDefinition(id: string, enabled: boolean): Promise<PersistedWorkflowDefinition>;

  /**
   * Launch a new run from an existing definition via the CF Workflows binding.
   * Creates a wf_runs record and updates run_count / last_run_at on the definition.
   * Throws if the definition is not found, disabled, or the binding is missing.
   */
  launchWorkflow(id: string, input?: Record<string, unknown>): Promise<PersistedWorkflowRun>;

  // ── Runs ───────────────────────────────────────────────────────────────────

  /**
   * Return all run records, optionally filtered by workflowDefinitionId.
   * For active runs, implementations should attempt a live status refresh.
   */
  listWorkflowRuns(workflowDefinitionId?: string): Promise<PersistedWorkflowRun[]>;

  /**
   * Return all active/waiting/paused runs for streaming to connected clients.
   * Implementations may return a cached snapshot; callers should not rely on
   * this being an exhaustive live status check — it is meant for SSE polling.
   */
  getActiveRunsForStream(): Promise<PersistedWorkflowRun[]>;

  /**
   * Return one run by ID, or null if missing.
   * Implementations should attempt a live CF status refresh for active runs.
   */
  getWorkflowRun(runId: string): Promise<PersistedWorkflowRun | null>;

  /**
   * Terminate an active run via the CF Workflows binding.
   * Throws if the run is not found or already in a terminal state.
   */
  terminateWorkflowRun(runId: string): Promise<PersistedWorkflowRun>;

  /**
   * Resume a paused/waiting run by sending a "resume" event.
   * ASSUMPTION: The workflow implementation calls step.waitForEvent("resume").
   * Throws if the run is not found or not in a resumable state.
   */
  resumeWorkflowRun(runId: string): Promise<PersistedWorkflowRun>;

  /**
   * Restart a terminal run by launching a new CF Workflows instance with the
   * original run's input.  Returns the new run record (new ID, status running).
   * Throws if the run is not found or still active.
   */
  restartWorkflowRun(runId: string): Promise<PersistedWorkflowRun>;

  /**
   * Approve a run waiting at an approval checkpoint by sending an "approved"
   * event.  Clears waitingForApproval on the run record.
   * Throws if the run is not found or not waiting for approval.
   */
  approveWorkflowRun(runId: string, comment?: string): Promise<PersistedWorkflowRun>;

  /**
   * Reject a run waiting at an approval checkpoint by sending a "rejected"
   * event.  Sets the run to errored / terminated depending on workflow logic.
   * Throws if the run is not found or not waiting for approval.
   */
  rejectWorkflowRun(runId: string, comment?: string): Promise<PersistedWorkflowRun>;

  /**
   * Send an arbitrary named event to a waiting run.
   * Throws if the run is not found or not in an active state.
   * (Named sendWorkflowRunEvent to avoid collision with Think base-class method.)
   */
  sendWorkflowRunEvent(
    runId:     string,
    eventType: string,
    payload?:  Record<string, unknown>,
  ): Promise<PersistedWorkflowRun>;

  /**
   * Return the binding names of every Cloudflare Workflow registered in this
   * worker's environment (i.e. every key in env whose value has a .create()
   * method).  Used by the frontend to populate the entrypoint dropdown when
   * creating or editing a workflow definition.
   */
  listWorkflowBindings(): string[];
}

// ── Response helpers ──────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function parseJsonBody(request: Request): Promise<unknown | Response> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("text/plain")) {
    return errJson("Content-Type must be application/json.", 415);
  }
  try {
    return await request.json();
  } catch {
    return errJson("Invalid JSON body.", 400);
  }
}

function notFoundOrRethrow(err: unknown, label: string): Response {
  const msg = err instanceof Error ? err.message : "";
  if (msg.toLowerCase().includes("not found")) {
    return errJson(`${label} not found.`, 404);
  }
  throw err;
}

// ── Sub-path parsing ──────────────────────────────────────────────────────────

function parseSubpath(pathname: string): string {
  const match = /\/workflows(\/[^?]*)?(?:[?]|$)/.exec(pathname);
  return "/workflows" + (match?.[1] ?? "");
}

// ── Wire serialization ────────────────────────────────────────────────────────

function serializeDef(d: PersistedWorkflowDefinition): WorkflowDefinitionApiResponse {
  return { ...d };
}

function serializeRun(r: PersistedWorkflowRun): WorkflowRunApiResponse {
  return { ...r };
}

// ── Input coercion helpers ────────────────────────────────────────────────────

function coerceDefInput(
  b: Record<string, unknown>,
): CreateWorkflowDefinitionInput {
  return {
    name:               (b.name as string).trim(),
    description:        typeof b.description    === "string" ? b.description.trim()    : undefined,
    workflowType:       typeof b.workflowType   === "string" ? b.workflowType          : undefined,
    triggerMode:        isTriggerMode(b.triggerMode)          ? b.triggerMode           : "manual",
    approvalMode:       isApprovalMode(b.approvalMode)        ? b.approvalMode          : "none",
    status:             isDefStatus(b.status)                 ? b.status                : "active",
    entrypoint:         (b.entrypoint as string).trim(),
    instructions:       typeof b.instructions   === "string" ? b.instructions.trim()   : undefined,
    inputSchemaText:    typeof b.inputSchemaText === "string" ? b.inputSchemaText.trim() : undefined,
    examplePayloadText: typeof b.examplePayloadText === "string" ? b.examplePayloadText.trim() : undefined,
    enabled:            typeof b.enabled === "boolean" ? b.enabled : true,
    tags:               Array.isArray(b.tags)
                          ? (b.tags as unknown[]).filter((t): t is string => typeof t === "string")
                          : [],
  };
}

function coerceDefPatch(
  b: Record<string, unknown>,
): UpdateWorkflowDefinitionInput {
  const patch: UpdateWorkflowDefinitionInput = {};
  if (typeof b.name             === "string")  patch.name             = b.name.trim();
  if (typeof b.description      === "string")  patch.description      = b.description.trim() || undefined;
  if (typeof b.workflowType     === "string")  patch.workflowType     = b.workflowType || undefined;
  if (isTriggerMode(b.triggerMode))            patch.triggerMode      = b.triggerMode;
  if (isApprovalMode(b.approvalMode))          patch.approvalMode     = b.approvalMode;
  if (isDefStatus(b.status))                   patch.status           = b.status;
  if (typeof b.entrypoint       === "string")  patch.entrypoint       = b.entrypoint.trim();
  if (typeof b.instructions     === "string")  patch.instructions     = b.instructions.trim() || undefined;
  if (typeof b.inputSchemaText  === "string")  patch.inputSchemaText  = b.inputSchemaText.trim() || undefined;
  if (typeof b.examplePayloadText === "string") patch.examplePayloadText = b.examplePayloadText.trim() || undefined;
  if (typeof b.enabled          === "boolean") patch.enabled          = b.enabled;
  if (Array.isArray(b.tags)) {
    patch.tags = (b.tags as unknown[]).filter((t): t is string => typeof t === "string");
  }
  return patch;
}

// ── Type guards for union literals ────────────────────────────────────────────

function isTriggerMode(v: unknown): v is "manual" | "scheduled" | "event" {
  return v === "manual" || v === "scheduled" || v === "event";
}

function isApprovalMode(v: unknown): v is "none" | "required" | "checkpoint" {
  return v === "none" || v === "required" || v === "checkpoint";
}

function isDefStatus(v: unknown): v is "draft" | "active" | "archived" {
  return v === "draft" || v === "active" || v === "archived";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ── SSE stream helper ─────────────────────────────────────────────────────────

/**
 * GET /workflows/runs/stream — Server-Sent Events endpoint.
 *
 * Emits a snapshot of all active/waiting/paused runs immediately, then sends
 * a ping every 25 s and closes after ~90 s so the browser `EventSource`
 * reconnects and picks up fresh state.  This "polling over SSE" model is
 * intentionally simple and reliable within Cloudflare Durable Object limits.
 *
 * Event shape:
 *   data: {"type":"run.update","run":{...WorkflowRun}}
 *   data: {"type":"ping"}
 *
 * NOTE (Cloudflare-specific): Durable Objects may hibernate between requests.
 * Do not assume the stream stays alive indefinitely — clients must reconnect
 * after the natural 90-second close or any error.
 */
async function handleRunStream(agent: WorkflowRouteAdapter): Promise<Response> {
  const PING_INTERVAL_MS  = 25_000;
  const MAX_STREAM_MS     = 90_000;

  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const encoder = new TextEncoder();

  function write(data: unknown) {
    try {
      controller?.enqueue(
        encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
      );
    } catch {
      // Client disconnected — ignore.
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      controller = ctrl;

      // Emit initial snapshot of all active runs.
      try {
        const runs = await agent.getActiveRunsForStream();
        for (const run of runs) {
          write({ type: "run.update", run });
        }
      } catch {
        // Persistence error — send a ping instead so the client knows we're up.
        write({ type: "ping" });
      }

      // Periodic ping to keep the connection alive past proxy timeouts.
      pingTimer = setInterval(() => write({ type: "ping" }), PING_INTERVAL_MS);

      // Close after MAX_STREAM_MS and let the client reconnect.
      closeTimer = setTimeout(() => {
        clearInterval(pingTimer);
        try { ctrl.close(); } catch { /* already closed */ }
      }, MAX_STREAM_MS);
    },
    cancel() {
      clearInterval(pingTimer);
      clearTimeout(closeTimer);
      controller = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      // Prevent buffering by reverse proxies.
      "X-Accel-Buffering": "no",
    },
  });
}

// ── Route dispatcher ──────────────────────────────────────────────────────────

/**
 * Entry point — call from MainAgent.onRequest() for any request whose
 * pathname includes "/workflows".
 */
export async function handleWorkflowRoute(
  request: Request,
  agent:   WorkflowRouteAdapter,
): Promise<Response> {
  const url     = new URL(request.url);
  const subpath = parseSubpath(url.pathname);
  const { method } = request;

  try {

    // ── GET /workflows/bindings ───────────────────────────────────────────────
    // Returns the binding names of all CF Workflow classes registered in env.
    // Used by the frontend to populate the entrypoint dropdown.
    if (subpath === "/workflows/bindings" && method === "GET") {
      const bindings = agent.listWorkflowBindings();
      return json({ bindings });
    }

    // ── GET /workflows ────────────────────────────────────────────────────────
    if (subpath === "/workflows" && method === "GET") {
      const definitions = await agent.listWorkflowDefinitions();
      const resp: WorkflowDefinitionsListResponse = {
        definitions: definitions.map(serializeDef),
        total:       definitions.length,
      };
      return json(resp);
    }

    // ── POST /workflows ───────────────────────────────────────────────────────
    if (subpath === "/workflows" && method === "POST") {
      const body = await parseJsonBody(request);
      if (body instanceof Response) return body;

      const b = body as Record<string, unknown>;
      if (!b.name       || typeof b.name !== "string" || !b.name.trim()) {
        return errJson('"name" must be a non-empty string.');
      }
      if (!b.entrypoint || typeof b.entrypoint !== "string" || !b.entrypoint.trim()) {
        return errJson('"entrypoint" must be a non-empty string.');
      }

      const def = await agent.createWorkflowDefinition(coerceDefInput(b));
      return json(serializeDef(def), 201);
    }

    // ── GET /workflows/runs/stream (SSE) ─────────────────────────────────────
    // Must come before /workflows/runs to avoid prefix-match collision.
    if (subpath === "/workflows/runs/stream" && method === "GET") {
      return handleRunStream(agent);
    }

    // ── GET /workflows/runs ───────────────────────────────────────────────────
    // Must be tested before /workflows/:id to avoid "runs" being treated as an id.
    if (subpath === "/workflows/runs" && method === "GET") {
      const workflowDefinitionId = url.searchParams.get("workflowDefinitionId") ?? undefined;
      const runs = await agent.listWorkflowRuns(workflowDefinitionId);
      const resp: WorkflowRunsListResponse = {
        runs:  runs.map(serializeRun),
        total: runs.length,
      };
      return json(resp);
    }

    // ── Routes under /workflows/runs/:runId[/action] ──────────────────────────
    const runActionMatch = /^\/workflows\/runs\/([^/]+)(?:\/([^/]+))?$/.exec(subpath);
    if (runActionMatch) {
      const runId  = decodeURIComponent(runActionMatch[1]);
      const action = runActionMatch[2] ?? "";

      // GET /workflows/runs/:runId
      if (!action && method === "GET") {
        const run = await agent.getWorkflowRun(runId);
        if (!run) return errJson(`Run "${runId}" not found.`, 404);
        return json(serializeRun(run));
      }

      if (method === "POST") {
        // POST /workflows/runs/:runId/terminate
        if (action === "terminate") {
          try {
            return json(serializeRun(await agent.terminateWorkflowRun(runId)));
          } catch (err) { return notFoundOrRethrow(err, `Run "${runId}"`); }
        }

        // POST /workflows/runs/:runId/resume
        if (action === "resume") {
          try {
            return json(serializeRun(await agent.resumeWorkflowRun(runId)));
          } catch (err) { return notFoundOrRethrow(err, `Run "${runId}"`); }
        }

        // POST /workflows/runs/:runId/restart
        if (action === "restart") {
          try {
            return json(serializeRun(await agent.restartWorkflowRun(runId)), 201);
          } catch (err) { return notFoundOrRethrow(err, `Run "${runId}"`); }
        }

        // POST /workflows/runs/:runId/approve
        if (action === "approve") {
          const body = await parseJsonBody(request);
          if (body instanceof Response) return body;
          const comment = isPlainObject(body) && typeof body.comment === "string"
            ? body.comment.trim() : undefined;
          try {
            return json(serializeRun(await agent.approveWorkflowRun(runId, comment)));
          } catch (err) { return notFoundOrRethrow(err, `Run "${runId}"`); }
        }

        // POST /workflows/runs/:runId/reject
        if (action === "reject") {
          const body = await parseJsonBody(request);
          if (body instanceof Response) return body;
          const comment = isPlainObject(body) && typeof body.comment === "string"
            ? body.comment.trim() : undefined;
          try {
            return json(serializeRun(await agent.rejectWorkflowRun(runId, comment)));
          } catch (err) { return notFoundOrRethrow(err, `Run "${runId}"`); }
        }

        // POST /workflows/runs/:runId/event
        if (action === "event") {
          const body = await parseJsonBody(request);
          if (body instanceof Response) return body;
          const b = body as Record<string, unknown>;
          if (!b.type || typeof b.type !== "string" || !b.type.trim()) {
            return errJson('"type" must be a non-empty string.');
          }
          const payload = isPlainObject(b.payload) ? b.payload : undefined;
          try {
            return json(serializeRun(
              await agent.sendWorkflowRunEvent(runId, b.type.trim(), payload),
            ));
          } catch (err) { return notFoundOrRethrow(err, `Run "${runId}"`); }
        }
      }

      return errJson(`Unknown run action: ${action || method}`, 404);
    }

    // ── Routes under /workflows/:id[/action] ──────────────────────────────────
    const defActionMatch = /^\/workflows\/([^/]+)(?:\/([^/]+))?$/.exec(subpath);
    if (defActionMatch) {
      const id     = decodeURIComponent(defActionMatch[1]);
      const action = defActionMatch[2] ?? "";

      // GET /workflows/:id
      if (!action && method === "GET") {
        const def = await agent.getWorkflowDefinition(id);
        if (!def) return errJson(`Definition "${id}" not found.`, 404);
        return json(serializeDef(def));
      }

      // PATCH /workflows/:id
      if (!action && method === "PATCH") {
        const body = await parseJsonBody(request);
        if (body instanceof Response) return body;
        try {
          const def = await agent.updateWorkflowDefinition(id, coerceDefPatch(body as Record<string, unknown>));
          return json(serializeDef(def));
        } catch (err) { return notFoundOrRethrow(err, `Definition "${id}"`); }
      }

      // DELETE /workflows/:id
      if (!action && method === "DELETE") {
        try {
          await agent.deleteWorkflowDefinition(id);
          return new Response(null, { status: 204 });
        } catch (err) { return notFoundOrRethrow(err, `Definition "${id}"`); }
      }

      // POST /workflows/:id/toggle
      if (action === "toggle" && method === "POST") {
        const body = await parseJsonBody(request);
        if (body instanceof Response) return body;
        const b = body as Record<string, unknown>;
        if (typeof b.enabled !== "boolean") {
          return errJson('"enabled" must be a boolean.');
        }
        try {
          const def = await agent.toggleWorkflowDefinition(id, b.enabled);
          return json(serializeDef(def));
        } catch (err) { return notFoundOrRethrow(err, `Definition "${id}"`); }
      }

      // POST /workflows/:id/launch
      if (action === "launch" && method === "POST") {
        const body = await parseJsonBody(request);
        if (body instanceof Response) return body;
        const b = body as Record<string, unknown>;
        const input = isPlainObject(b.input) ? b.input : undefined;
        try {
          const run = await agent.launchWorkflow(id, input);
          return json(serializeRun(run), 201);
        } catch (err) { return notFoundOrRethrow(err, `Definition "${id}"`); }
      }
    }

    return errJson(`Unknown workflows route: ${subpath}`, 404);

  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error.";
    console.error("[workflowsRoutes]", err);
    return errJson(message, 500);
  }
}
