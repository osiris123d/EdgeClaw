import test from "node:test";
import assert from "node:assert/strict";
import { isCodemodeRouterPlumbingFailureMessage } from "../codemodeRouterPlumbing";

test("plumbing classifier matches Rpc receiver errors", () => {
  assert.equal(
    isCodemodeRouterPlumbingFailureMessage(
      'RPC receiver does not implement method "tools_find"'
    ),
    true
  );
});

test("plumbing classifier matches codemode undefined wording", () => {
  assert.equal(isCodemodeRouterPlumbingFailureMessage("codemode is undefined"), true);
  assert.equal(isCodemodeRouterPlumbingFailureMessage("ReferenceError: codemode"), true);
});

test("plumbing classifier matches helper not-a-function wording", () => {
  assert.equal(isCodemodeRouterPlumbingFailureMessage("tools_find is not a function"), true);
  assert.equal(isCodemodeRouterPlumbingFailureMessage("openapi_search is not a function"), true);
});

test("plumbing classifier ignores ordinary tool errors", () => {
  assert.equal(isCodemodeRouterPlumbingFailureMessage('Tool "missing" threw 404'), false);
});
