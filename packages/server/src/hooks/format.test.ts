import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "../service/types.ts";
import { formatEvents, formatWhen } from "./format.ts";

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    specversion: "1.0",
    id: "evt-1",
    source: "urn:test",
    type: "local.test.a",
    time: "2026-04-11T14:30:00.000Z",
    publishedAt: "2026-04-11T14:30:00.000Z",
    datacontenttype: "application/json",
    data: {},
    ...overrides,
  };
}

describe("formatWhen", () => {
  test("under a minute is 'just now'", () => {
    const now = new Date("2026-04-11T14:30:30Z");
    const t = new Date("2026-04-11T14:30:00Z");
    expect(formatWhen(t, now)).toMatch(/^just now \(/);
  });

  test("several minutes renders 'N min ago'", () => {
    const now = new Date("2026-04-11T14:35:00Z");
    const t = new Date("2026-04-11T14:30:00Z");
    expect(formatWhen(t, now)).toMatch(/^5 min ago \(/);
  });

  test("hours uses plural correctly", () => {
    const now = new Date("2026-04-11T17:30:00Z");
    expect(formatWhen(new Date("2026-04-11T16:30:00Z"), now)).toMatch(/^1 hour ago \(/);
    expect(formatWhen(new Date("2026-04-11T14:30:00Z"), now)).toMatch(/^3 hours ago \(/);
  });

  test("days uses plural correctly", () => {
    const now = new Date("2026-04-13T14:30:00Z");
    expect(formatWhen(new Date("2026-04-12T14:30:00Z"), now)).toMatch(/^1 day ago \(/);
    expect(formatWhen(new Date("2026-04-10T14:30:00Z"), now)).toMatch(/^3 days ago \(/);
  });
});

describe("formatEvents", () => {
  test("empty list shows header with zero count", () => {
    const now = new Date("2026-04-11T14:35:00Z");
    const out = formatEvents([], now);
    expect(out).toContain("0 new events");
  });

  test("single event uses singular 'event'", () => {
    const now = new Date("2026-04-11T14:35:00Z");
    const out = formatEvents(
      [
        makeEvent({
          source: "urn:test:a",
          type: "local.test.a",
          data: { foo: "bar" },
        }),
      ],
      now,
    );
    expect(out).toContain("1 new event\n");
    expect(out).toContain("from: urn:test:a");
    expect(out).toContain("type: local.test.a");
    expect(out).toContain("  foo: bar");
  });

  test("multiple events are separated by horizontal bars", () => {
    const now = new Date("2026-04-11T14:35:00Z");
    const out = formatEvents(
      [
        makeEvent({ id: "1", type: "local.a.one", data: { x: 1 } }),
        makeEvent({ id: "2", type: "local.a.two", data: { y: 2 } }),
      ],
      now,
    );
    expect(out).toContain("2 new events");
    const bars = out.match(/─{40}/g) ?? [];
    expect(bars.length).toBeGreaterThanOrEqual(4);
  });

  test("nested object data renders as indented YAML", () => {
    const now = new Date("2026-04-11T14:35:00Z");
    const out = formatEvents(
      [
        makeEvent({
          data: {
            pr: { number: 104, title: "fix: regression" },
            action: "synchronize",
          },
        }),
      ],
      now,
    );
    expect(out).toContain("  pr:");
    expect(out).toContain("    number: 104");
    expect(out).toContain("    title: fix: regression");
    expect(out).toContain("  action: synchronize");
  });

  test("array data renders with '-' entries", () => {
    const now = new Date("2026-04-11T14:35:00Z");
    const out = formatEvents([makeEvent({ data: { files: ["a.txt", "b.txt"] } })], now);
    expect(out).toContain("  files:");
    expect(out).toContain("    - a.txt");
    expect(out).toContain("    - b.txt");
  });
});
