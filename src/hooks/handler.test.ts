import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../config/config.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "../service/service.ts";
import { handleHook } from "./handler.ts";

function makeFixture(nowMs = 1_700_000_000_000) {
  const db = openDb(":memory:");
  const config = parseConfigText("");
  let t = nowMs;
  const svc = new Service(db, config, () => {
    const v = t;
    t += 1;
    return v;
  });
  return { db, svc };
}

describe("handleHook", () => {
  test("non-delivery hook returns 204 and publishes lifecycle event", () => {
    const { svc } = makeFixture();
    const res = handleHook(svc, "PostToolUse", "sess-a", { tool: "Edit" });
    expect(res.status).toBe(204);
    const events = svc.queryEvents({ type: "agent.claude.post-tool-use.sess-a" });
    expect(events.length).toBe(1);
    expect(events[0]?.source).toBe("urn:unguibus:hook:sess-a");
    const data = events[0]?.data as { tool?: string };
    expect(data.tool).toBe("Edit");
  });

  test("delivery hook returns 200 with additionalContext", () => {
    const { svc } = makeFixture();
    svc.subscribe("sess-b", "local.test.*");
    svc.publishEvent({ source: "urn:ext", type: "local.test.ping", data: { n: 1 } });
    const res = handleHook(svc, "SessionStart", "sess-b", {}, () => new Date(1_700_000_000_000));
    expect(res.status).toBe(200);
    if (res.status !== 200) throw new Error("unreachable");
    expect(res.additionalContext).toContain("1 new event");
    expect(res.additionalContext).toContain("local.test.ping");
  });

  test("delivery hook's own lifecycle event is filtered out", () => {
    const { svc } = makeFixture();
    svc.subscribe("sess-c", "agent.claude.*.sess-c");
    const res = handleHook(svc, "PreToolUse", "sess-c", { tool: "Read" });
    expect(res.status).toBe(200);
    if (res.status !== 200) throw new Error("unreachable");
    expect(res.additionalContext).toContain("0 new events");
  });

  test("SessionStart stores ppid when provided", () => {
    const { svc, db } = makeFixture();
    handleHook(svc, "SessionStart", "sess-d", { ppid: 54321 });
    const row = db
      .query<{ pid: number | null }, [string]>("SELECT pid FROM sessions WHERE sessionId = ?")
      .get("sess-d");
    expect(row?.pid).toBe(54321);
  });

  test("SessionEnd clears pid", () => {
    const { svc, db } = makeFixture();
    handleHook(svc, "SessionStart", "sess-e", { ppid: 99 });
    handleHook(svc, "SessionEnd", "sess-e", {});
    const row = db
      .query<{ pid: number | null }, [string]>("SELECT pid FROM sessions WHERE sessionId = ?")
      .get("sess-e");
    expect(row?.pid).toBeNull();
  });

  test("Stop promotes pendingLastUpdated to lastUpdated", () => {
    const { svc, db } = makeFixture();
    svc.subscribe("sess-f", "local.x.*");
    svc.publishEvent({ source: "urn:ext", type: "local.x.a" });
    svc.publishEvent({ source: "urn:ext", type: "local.x.b" });
    const claimed = svc.claimPendingEvents("sess-f");
    expect(claimed.length).toBe(2);
    const before = db
      .query<{ lastUpdated: string | null; pendingLastUpdated: string | null }, [string]>(
        "SELECT lastUpdated, pendingLastUpdated FROM sessions WHERE sessionId = ?",
      )
      .get("sess-f");
    expect(before?.pendingLastUpdated).toBeTruthy();
    expect(before?.lastUpdated).toBeNull();

    handleHook(svc, "Stop", "sess-f", {});
    const after = db
      .query<{ lastUpdated: string | null; pendingLastUpdated: string | null }, [string]>(
        "SELECT lastUpdated, pendingLastUpdated FROM sessions WHERE sessionId = ?",
      )
      .get("sess-f");
    expect(after?.lastUpdated).toBe(before?.pendingLastUpdated ?? "");
    expect(after?.pendingLastUpdated).toBeNull();
  });

  test("updates lastHookTime", () => {
    const { svc, db } = makeFixture();
    handleHook(svc, "Notification", "sess-g", {});
    const row = db
      .query<{ lastHookTime: string | null }, [string]>(
        "SELECT lastHookTime FROM sessions WHERE sessionId = ?",
      )
      .get("sess-g");
    expect(row?.lastHookTime).toBeTruthy();
  });

  test("rejects empty sessionId", () => {
    const { svc } = makeFixture();
    expect(() => handleHook(svc, "PreToolUse", "", {})).toThrow(/sessionId/);
  });

  test("kebab-cases multi-word hook names", () => {
    const { svc } = makeFixture();
    handleHook(svc, "UserPromptSubmit", "sess-h", { prompt: "hi" });
    const events = svc.queryEvents({ type: "agent.claude.user-prompt-submit.sess-h" });
    expect(events.length).toBe(1);
  });
});
