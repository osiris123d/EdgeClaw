import type { ProjectAutonomyRunner } from "./projectAutonomyHttp.shared";
import {
  DEBUG_PROJECT_AUTONOMY_FORWARDED_QUERY_HEADER,
  parseProjectAutonomyRequest,
  urlForProjectAutonomyParsing,
} from "./projectAutonomyHttp.shared";

export type { ProjectAutonomyScenarioInput, ProjectAutonomyRunner } from "./projectAutonomyHttp.shared";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * MainAgent DO handler for `/debug/project-autonomy` (Worker rewrites from `/api/debug/project-autonomy`).
 */
export async function handleProjectAutonomyDoRequest(
  request: Request,
  runner: ProjectAutonomyRunner
): Promise<Response> {
  const url = urlForProjectAutonomyParsing(request);
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed", debug: true }, 405);
  }

  try {
    const input = await parseProjectAutonomyRequest(request, url);

    console.info(
      "debug_project_autonomy_query_flags_parsed",
      JSON.stringify({
        requestUrl: request.url,
        forwardedQueryHeader:
          request.headers.get(DEBUG_PROJECT_AUTONOMY_FORWARDED_QUERY_HEADER) ?? null,
        parsedUrlHref: url.href,
        raw: {
          childTurn: url.searchParams.get("childTurn"),
          codingLoopMaxIterations: url.searchParams.get("codingLoopMaxIterations"),
          disableSharedWorkspaceTools: url.searchParams.get("disableSharedWorkspaceTools"),
          taskId: url.searchParams.get("taskId"),
        },
        resolved: {
          childTurn: input.childTurn ?? null,
          loopMaxIterations:
            typeof input.codingLoopMaxIterations === "number" ? input.codingLoopMaxIterations : null,
          disableSharedWorkspaceTools: input.disableSharedWorkspaceTools === true,
          taskId: input.taskId ?? null,
        },
      })
    );

    const result = await runner.runProjectAutonomyScenario(input);
    return json(result, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const errName = e instanceof Error ? e.name : "non-Error";
    console.error(
      "project_autonomy_handler_error",
      JSON.stringify({
        errName,
        message: msg.length > 4000 ? `${msg.slice(0, 4000)}…` : msg,
      })
    );
    return json({ error: msg, debug: true }, 400);
  }
}
