import { describe, expect, test } from "bun:test";
import {
  isReservedType,
  isValidConnectorName,
  isValidEventId,
  isValidPattern,
  isValidType,
  matchesPattern,
} from "./grammar.ts";

describe("grammar", () => {
  test("type validation", () => {
    expect(isValidType("service.github.pr-created.repo")).toBe(true);
    expect(isValidType("agent")).toBe(true);
    expect(isValidType("")).toBe(false);
    expect(isValidType(".leading")).toBe(false);
    expect(isValidType("trailing.")).toBe(false);
    expect(isValidType("has space.thing")).toBe(false);
  });

  test("pattern allows * segments (but not in first position)", () => {
    expect(isValidPattern("service.*.pr-created.*")).toBe(true);
    expect(isValidPattern("service.slack.*")).toBe(true);
    // First segment (category) must be a literal — design regex requires it.
    expect(isValidPattern("*.thing")).toBe(false);
    expect(isValidPattern("**.thing")).toBe(false);
  });

  test("reserved namespace", () => {
    expect(isReservedType("service.unguibus.spawn-failed.abc")).toBe(true);
    expect(isReservedType("service.github.pr-created.repo")).toBe(false);
  });

  test("matchesPattern respects segment count", () => {
    expect(matchesPattern("service.slack.*", "service.slack.message-posted")).toBe(true);
    expect(matchesPattern("service.slack.*", "service.slack.message-posted.general")).toBe(false);
    expect(matchesPattern("service.*.repo-updated.*.*", "service.github.repo-updated.a.b")).toBe(
      true,
    );
    expect(matchesPattern("service.github.repo-updated.*", "service.github.repo-updated")).toBe(
      false,
    );
  });

  test("connector name grammar", () => {
    expect(isValidConnectorName("gh-designs-commits")).toBe(true);
    expect(isValidConnectorName("has.dot")).toBe(false);
    expect(isValidConnectorName("")).toBe(false);
  });

  test("event id grammar", () => {
    expect(isValidEventId("abc123")).toBe(true);
    expect(isValidEventId("a b-c")).toBe(true);
    expect(isValidEventId("")).toBe(false);
    expect(isValidEventId("has\nnewline")).toBe(false);
    expect(isValidEventId("x".repeat(257))).toBe(false);
  });
});
