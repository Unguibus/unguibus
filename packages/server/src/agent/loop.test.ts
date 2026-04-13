import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../config/config.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "../service/service.ts";
import { type AgentLoopOptions, type SpawnFn, startAgentLoop } from "./loop.ts";

function makeHarness(configText = "") {
  const db = openDb(":memory:");
  const config = parseConfigText(configText);
  let now = 1_700_000_000_000;
  const nowMs = () => now;
  const advance = (ms: number) => {
    now += ms;
  };
  const svc = new Service(db, config, nowMs);
  return { db, config, svc, nowMs, advance };
}

function startLoop(h: ReturnType<typeof makeHarness>, opts: AgentLoopOptions = {}) {
  return startAgentLoop(h.svc, h.config, {
    autoStart: false,
    nowMs: h.nowMs,
    checkAlive: () => false,
    killPid: async () => {},
    ...opts,
  });
}

describe("agent loop", () => {
  test("no-op when no candidates", async () => {
    const h = makeHarness();
    const spawnCalls: string[] = [];
    const spawn: SpawnFn = async (sid) => {
      spawnCalls.push(sid);
      return { ok: true, pid: 1 };
    };
    const loop = startLoop(h, { spawn });
    await loop.tick();
    expect(spawnCalls).toEqual([]);
    await loop.stop();
  });

  test("spawns claude for session with pending events and records pid", async () => {
    const h = makeHarness();
    const sid = "sess-1";
    h.svc.subscribe(sid, "local.thing.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.thing.hello" });
    h.advance(5);

    const calls: { sid: string; prompt: string }[] = [];
    const spawn: SpawnFn = async (sessionId, prompt) => {
      calls.push({ sid: sessionId, prompt });
      return { ok: true, pid: 42 };
    };
    const loop = startLoop(h, { spawn });
    await loop.tick();

    expect(calls.length).toBe(1);
    expect(calls[0]?.sid).toBe(sid);
    expect(calls[0]?.prompt).toContain("1 new event");
    expect(calls[0]?.prompt).toContain("local.thing.hello");

    const live = h.svc.listLivePidSessions();
    expect(live.length).toBe(1);
    expect(live[0]?.pid).toBe(42);
    await loop.stop();
  });

  test("skips candidate whose pid is alive", async () => {
    const h = makeHarness();
    const sid = "sess-alive";
    h.svc.subscribe(sid, "local.a.*");
    h.svc.setSessionPid(sid, 9999);
    h.svc.publishEvent({ source: "urn:x", type: "local.a.one" });

    const spawnCalls: string[] = [];
    const spawn: SpawnFn = async (s) => {
      spawnCalls.push(s);
      return { ok: true, pid: 1 };
    };
    const loop = startLoop(h, {
      spawn,
      checkAlive: (pid) => pid === 9999,
    });
    await loop.tick();
    expect(spawnCalls).toEqual([]);
    await loop.stop();
  });

  test("clears dead pid then proceeds to spawn", async () => {
    const h = makeHarness();
    const sid = "sess-dead";
    h.svc.subscribe(sid, "local.d.*");
    h.svc.setSessionPid(sid, 12345);
    h.svc.publishEvent({ source: "urn:x", type: "local.d.ping" });

    const calls: number[] = [];
    const spawn: SpawnFn = async () => {
      calls.push(1);
      return { ok: true, pid: 77 };
    };
    const loop = startLoop(h, { spawn });
    await loop.tick();
    expect(calls.length).toBe(1);
    expect(h.svc.listLivePidSessions()[0]?.pid).toBe(77);
    await loop.stop();
  });

  test("spawn failure increments failures and sets backoff", async () => {
    const h = makeHarness();
    const sid = "sess-fail";
    h.svc.subscribe(sid, "local.f.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.f.one" });

    const spawn: SpawnFn = async () => ({ ok: false, error: "nope" });
    const loop = startLoop(h, { spawn, spawnFailureThreshold: 3 });
    await loop.tick();

    const cand = h.svc.listLoopCandidates().find((c) => c.sessionId === sid);
    expect(cand?.spawnBackoffUntil).not.toBeNull();
    const evs = h.svc.queryEvents({ type: `service.unguibus.spawn-failed.${sid}` });
    expect(evs.length).toBe(0);
    await loop.stop();
  });

  test("emits service.unguibus.spawn-failed.<sid> after threshold failures", async () => {
    const h = makeHarness();
    const sid = "sess-threshold";
    h.svc.subscribe(sid, "local.t.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.t.one" });

    const spawn: SpawnFn = async () => ({ ok: false, error: "boom" });
    const loop = startLoop(h, { spawn, spawnFailureThreshold: 2 });

    await loop.tick();
    h.advance(h.config.server.loopIntervalMs + 10_000);
    await loop.tick();

    const evs = h.svc.queryEvents({ type: `service.unguibus.spawn-failed.${sid}` });
    expect(evs.length).toBe(1);
    await loop.stop();
  });

  test("respects spawnBackoffUntil and does not spawn during backoff", async () => {
    const h = makeHarness();
    const sid = "sess-backoff";
    h.svc.subscribe(sid, "local.b.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.b.one" });

    let spawnCount = 0;
    const spawn: SpawnFn = async () => {
      spawnCount += 1;
      return { ok: false, error: "fail" };
    };
    const loop = startLoop(h, { spawn, spawnFailureThreshold: 99 });
    await loop.tick();
    expect(spawnCount).toBe(1);
    await loop.tick();
    expect(spawnCount).toBe(1);
    await loop.stop();
  });

  test("caps events per delivery and advances watermark to boundary", async () => {
    const h = makeHarness("[server]\nmaxEventsPerDelivery = 2\n");
    const sid = "sess-cap";
    h.svc.subscribe(sid, "local.c.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.c.a" });
    h.advance(1);
    h.svc.publishEvent({ source: "urn:x", type: "local.c.b" });
    h.advance(1);
    h.svc.publishEvent({ source: "urn:x", type: "local.c.c" });

    const calls: { prompt: string }[] = [];
    const spawn: SpawnFn = async (_s, prompt) => {
      calls.push({ prompt });
      return { ok: true, pid: 99 };
    };
    const loop = startLoop(h, { spawn });
    await loop.tick();

    expect(calls[0]?.prompt).toContain("2 new events");
    expect(calls[0]?.prompt).toContain("local.c.a");
    expect(calls[0]?.prompt).toContain("local.c.b");
    expect(calls[0]?.prompt).not.toContain("local.c.c");
    await loop.stop();
  });

  test("watchdog marks pendingWarning when idle > warnAfter", async () => {
    const h = makeHarness(`[watchdog]\nwarnAfter = "100ms"\nkillAfter = "500ms"\n`);
    const sid = "sess-warn";
    h.svc.updateLastHookTime(sid);
    h.svc.setSessionPid(sid, 1234);

    h.advance(h.config.watchdog.warnAfterMs + 10);
    const loop = startLoop(h, {
      checkAlive: (pid) => pid === 1234,
      spawn: async () => ({ ok: true, pid: 1 }),
    });
    await loop.tick();
    const live = h.svc.listLivePidSessions().find((s) => s.sessionId === sid);
    expect(live?.pendingWarning).toBe(true);
    await loop.stop();
  });

  test("watchdog kills pid and clears session when idle > killAfter", async () => {
    const h = makeHarness(`[watchdog]\nwarnAfter = "100ms"\nkillAfter = "500ms"\n`);
    const sid = "sess-kill";
    h.svc.updateLastHookTime(sid);
    h.svc.setSessionPid(sid, 5555);

    h.advance(h.config.watchdog.killAfterMs + 10);
    const killed: number[] = [];
    const loop = startLoop(h, {
      checkAlive: (pid) => pid === 5555,
      killPid: async (pid) => {
        killed.push(pid);
      },
      spawn: async () => ({ ok: true, pid: 1 }),
    });
    await loop.tick();
    expect(killed).toEqual([5555]);
    expect(h.svc.listLivePidSessions().find((s) => s.sessionId === sid)).toBeUndefined();
    await loop.stop();
  });

  test("service mutation sets dirty via callback", async () => {
    const h = makeHarness();
    const loop = startLoop(h, { spawn: async () => ({ ok: true, pid: 1 }) });
    expect(loop.status().dirty).toBe(false);
    h.svc.publishEvent({ source: "urn:x", type: "local.m.a" });
    expect(loop.status().dirty).toBe(true);
    await loop.stop();
  });

  test("status reports lastLoopTime after tick", async () => {
    const h = makeHarness();
    const loop = startLoop(h, { spawn: async () => ({ ok: true, pid: 1 }) });
    expect(loop.status().lastLoopTime).toBeNull();
    await loop.tick();
    expect(loop.status().lastLoopTime).not.toBeNull();
    await loop.stop();
  });

  test("stop() unregisters dirty callback and status provider", async () => {
    const h = makeHarness();
    const loop = startLoop(h, { spawn: async () => ({ ok: true, pid: 1 }) });
    await loop.stop();
    const status = h.svc.getAgentStatus();
    expect(status.state).toBe("idle");
    expect(status.lastLoopTime).toBeNull();
    expect(status.recentCadenceMs).toBe(0);
  });
});
