import { shouldInjectVisibleAssistantMessage, VisibleAssistantInjectionParams } from "../visibleAssistantInjectionHelper";
import { describe, it, expect } from "vitest";

describe("shouldInjectVisibleAssistantMessage", () => {
  function run(params: Partial<VisibleAssistantInjectionParams> & { replyText: string }): boolean {
    return shouldInjectVisibleAssistantMessage({
      resultMessageText: params.resultMessageText ?? "",
      replyText: params.replyText,
      latch: params.latch ?? false,
      shouldInject: params.shouldInject ?? true,
    }).shouldInject;
  }

  it("existing preamble does not suppress table injection", () => {
    expect(run({
      resultMessageText: "Status: All good.\n", // unrelated preamble
      replyText: "| Rule Id | Rule Name |\n| --- | --- |\n| 1 | foo |",
    })).toBe(true);
  });

  it("exact duplicate visible text suppresses injection", () => {
    expect(run({
      resultMessageText: "\n| Rule Id | Rule Name |\n| --- | --- |\n| 1 | foo |\n",
      replyText: "| Rule Id | Rule Name |\n| --- | --- |\n| 1 | foo |",
    })).toBe(false);
  });

  it("success latch suppresses second injection", () => {
    expect(run({
      resultMessageText: "",
      replyText: "| Rule Id | Rule Name |\n| --- | --- |\n| 1 | foo |",
      latch: true,
    })).toBe(false);
  });

  it("failure latch suppresses second injection", () => {
    expect(run({
      resultMessageText: "",
      replyText: "Failure: Something went wrong.",
      latch: true,
    })).toBe(false);
  });

  it("success and failure latches are independent", () => {
    // Simulate success latch set, failure latch not set
    expect(run({
      resultMessageText: "",
      replyText: "Failure: Something went wrong.",
      latch: false,
      shouldInject: true,
    })).toBe(true);
    // Simulate failure latch set, success latch not set
    expect(run({
      resultMessageText: "",
      replyText: "| Rule Id | Rule Name |\n| --- | --- |\n| 1 | foo |",
      latch: false,
      shouldInject: true,
    })).toBe(true);
  });
});
