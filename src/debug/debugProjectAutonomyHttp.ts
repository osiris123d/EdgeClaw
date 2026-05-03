import type { ProjectAutonomyRunner } from "./projectAutonomyHttp.shared";
import { parseProjectAutonomyRequest } from "./projectAutonomyHttp.shared";

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
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed", debug: true }, 405);
  }

  try {
    const input = await parseProjectAutonomyRequest(request, url);
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
