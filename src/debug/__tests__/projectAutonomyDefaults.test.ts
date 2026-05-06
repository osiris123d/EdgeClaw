import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectAutonomyRequest } from "../projectAutonomyHttp.shared";

test("project-autonomy GET without codingLoopMaxIterations leaves iteration override unset", async () => {
  const url = new URL(
    "https://example.test/debug/project-autonomy?projectId=proj-x&session=default&mode=success"
  );
  const req = new Request(url.href, { method: "GET" });
  const input = await parseProjectAutonomyRequest(req, url);
  assert.equal(input.codingLoopMaxIterations, undefined);
  assert.equal(input.projectId, "proj-x");
});

test("project-autonomy GET with codingLoopMaxIterations pins orchestration max iterations", async () => {
  const url = new URL(
    "https://example.test/debug/project-autonomy?projectId=proj-x&session=default&codingLoopMaxIterations=7"
  );
  const req = new Request(url.href, { method: "GET" });
  const input = await parseProjectAutonomyRequest(req, url);
  assert.equal(input.codingLoopMaxIterations, 7);
});
