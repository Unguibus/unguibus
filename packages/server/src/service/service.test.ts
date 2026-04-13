import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../config/config.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "./service.ts";
import { ServiceError } from "./types.ts";

function makeService(configText = "", nowMs = 1_700_000_000_000) {
  const db = openDb(":memory:");
  const config = parseConfigText(configText);
  let t = nowMs;
  const svc = new Service(db, config, () => {
    const v = t;
    t += 1;
    return v;
  });
  return { svc, db };
}

describe("publishEvent", () => {
  test("assigns id/time/publishedAt when omitted", () => {
    const { svc } = makeService();
    const res = svc.publishEvent({ source: "urn:test", type: "local.test.a" });
    expect(res.created).toBe(true);
    expect(res.event.id).toMatch(/[a-f0-9-]{36}/);
    expect(res.event.specversion).toBe("1.0");
    expect(res.event.datacontenttype).toBe("application/json");
    expect(typeof res.event.publishedAt).toBe("string");
  });

  test("is idempotent on caller-supplied id", () => {
    const { svc } = makeService();
    const a = svc.publishEvent({ source: "urn:x", type: "local.test.b", id: "abc" });
    const b = svc.publishEvent({ source: "urn:y", type: "local.test.b", id: "abc" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.event.source).toBe("urn:x");
  });

  test("rejects reserved namespace", () => {
    const { svc } = makeService();
    expect(() => svc.publishEvent({ source: "urn:x", type: "service.unguibus.foo.bar" })).toThrow(
      ServiceError,
    );
  });

  test("rejects invalid specversion", () => {
    const { svc } = makeService();
    expect(() =>
      svc.publishEvent({ source: "urn:x", type: "local.a.b", specversion: "2.0" }),
    ).toThrow(/specversion/);
  });
});

describe("queryEvents", () => {
  test("filters by type pattern (wildcard)", () => {
    const { svc } = makeService();
    svc.publishEvent({ source: "urn:x", type: "service.slack.message-posted" });
    svc.publishEvent({ source: "urn:x", type: "service.slack.message-posted.general" });
    svc.publishEvent({ source: "urn:x", type: "service.github.pr-created.repo.1" });
    const matches = svc.queryEvents({ type: "service.slack.*" });
    expect(matches.length).toBe(1);
    expect(matches[0]?.type).toBe("service.slack.message-posted");
  });

  test("default order is desc by publishedAt", () => {
    const { svc } = makeService();
    svc.publishEvent({ source: "urn:x", type: "local.a.one" });
    svc.publishEvent({ source: "urn:x", type: "local.a.two" });
    const rows = svc.queryEvents({});
    expect(rows[0]?.type).toBe("local.a.two");
  });
});

describe("subscribe/tag idempotency", () => {
  test("re-subscribe is a no-op", () => {
    const { svc } = makeService();
    svc.subscribe("s1", "local.*");
    svc.subscribe("s1", "local.*");
    expect(svc.listSubscriptions("s1")).toEqual(["local.*"]);
  });

  test("re-tag is a no-op", () => {
    const { svc } = makeService();
    svc.tag("s1", "t");
    svc.tag("s1", "t");
    expect(svc.listTags("s1")).toEqual(["t"]);
  });
});

describe("pending + claim", () => {
  test("routes via direct subscription", () => {
    const { svc } = makeService();
    svc.subscribe("s1", "local.foo.*");
    svc.publishEvent({ source: "urn:x", type: "local.foo.a" });
    svc.publishEvent({ source: "urn:x", type: "local.bar.a" });
    const pending = svc.getPendingEvents("s1");
    expect(pending.length).toBe(1);
    expect(pending[0]?.type).toBe("local.foo.a");
  });

  test("routes via tag-based config subscription", () => {
    const { svc } = makeService(`
[[subscriptions]]
pattern = "service.github.pr-updated.*.*.*"
tag = "pr-reviewer"
`);
    svc.tag("s1", "pr-reviewer");
    svc.publishEvent({ source: "urn:x", type: "service.github.pr-updated.org.repo.1" });
    svc.publishEvent({ source: "urn:x", type: "service.slack.message-posted.general" });
    const pending = svc.getPendingEvents("s1");
    expect(pending.length).toBe(1);
    expect(pending[0]?.type).toBe("service.github.pr-updated.org.repo.1");
  });

  test("filters self-events (urn:unguibus:hook:<sessionId>)", () => {
    const { svc } = makeService();
    svc.subscribe("s1", "agent.claude.*.s1");
    svc.publishEvent({
      source: "urn:unguibus:hook:s1",
      type: "agent.claude.pre-tool-use.s1",
    });
    svc.publishEvent({
      source: "urn:unguibus:hook:other",
      type: "agent.claude.pre-tool-use.s1",
    });
    const pending = svc.getPendingEvents("s1");
    expect(pending.length).toBe(1);
    expect(pending[0]?.source).toBe("urn:unguibus:hook:other");
  });

  test("claim advances watermark; subsequent claims see nothing", () => {
    const { svc } = makeService();
    svc.subscribe("s1", "local.*.*");
    svc.publishEvent({ source: "urn:x", type: "local.foo.a" });
    svc.publishEvent({ source: "urn:x", type: "local.foo.b" });
    const first = svc.claimPendingEvents("s1");
    expect(first.length).toBe(2);
    const second = svc.claimPendingEvents("s1");
    expect(second.length).toBe(0);
  });

  test("claim respects maxEventsPerDelivery", () => {
    const { svc } = makeService(`
[server]
maxEventsPerDelivery = 2
`);
    svc.subscribe("s1", "local.*.*");
    svc.publishEvent({ source: "urn:x", type: "local.foo.a" });
    svc.publishEvent({ source: "urn:x", type: "local.foo.b" });
    svc.publishEvent({ source: "urn:x", type: "local.foo.c" });
    const first = svc.claimPendingEvents("s1");
    expect(first.length).toBe(2);
    const second = svc.claimPendingEvents("s1");
    expect(second.length).toBe(1);
    expect(second[0]?.type).toBe("local.foo.c");
  });
});
