import { describe, expect, test } from "bun:test";
import { parseDurationMs } from "./duration.ts";

describe("parseDurationMs", () => {
  test("parses simple units", () => {
    expect(parseDurationMs("1ms")).toBe(1);
    expect(parseDurationMs("1s")).toBe(1_000);
    expect(parseDurationMs("1m")).toBe(60_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("1w")).toBe(604_800_000);
  });

  test("parses compound durations", () => {
    expect(parseDurationMs("1h30m")).toBe(3_600_000 + 30 * 60_000);
    expect(parseDurationMs("2m30s")).toBe(2 * 60_000 + 30_000);
  });

  test("parses decimal and micro", () => {
    expect(parseDurationMs("1.5s")).toBe(1_500);
    expect(parseDurationMs("500us")).toBe(0.5);
    expect(parseDurationMs("500µs")).toBe(0.5);
  });

  test("rejects garbage", () => {
    expect(() => parseDurationMs("")).toThrow();
    expect(() => parseDurationMs("1y")).toThrow();
    expect(() => parseDurationMs("abc")).toThrow();
    expect(() => parseDurationMs("1s 30")).toThrow();
  });
});
