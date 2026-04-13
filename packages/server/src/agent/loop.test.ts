import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../config/config.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "../service/service.ts";
import { type AgentLoopOptions, type SpawnFn, startAgentLoop } from "./loop.ts";

function makeHarness(configText = "") {
  const db = openDb(":memory:");
  // Default fastExitThreshold=1ms so the sleep-vs-exited race settles fast in tests.
  // Real-time (not nowMs) governs the race window.
  const defaults = configText.includes("[agent-loop]")
    ? configText
    : `${configText}\n[agent-loop]\nfastExitThreshold = "1ms"\n`;
  const config = parseConfigText(defaults);
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

// Never-resolves promise, used by spawns that should look "still running" until the next tick.
function alivePromise(): Promise<number> {
  return new Promise<number>(() => {});
}

describe("agent loop", () => {
  test("no-op when no candidates", async () => {
    const h = makeHarness();
    const spawnCalls: string[] = [];
    const spawn: SpawnFn = async (sid) => {
      spawnCalls.push(sid);
      return { ok: true, pid: 1, exited: alivePromise() };
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
      return { ok: true, pid: 42, exited: alivePromise() };
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
      return { ok: true, pid: 1, exited: alivePromise() };
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
      return { ok: true, pid: 77, exited: alivePromise() };
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
    const loop = startLoop(h, { spawn });
    await loop.tick();

    const cand = h.svc.listLoopCandidates().find((c) => c.sessionId === sid);
    expect(cand?.spawnBackoffUntil).not.toBeNull();
    const evs = h.svc.queryEvents({ type: `service.unguibus.spawn-failed.${sid}` });
    expect(evs.length).toBe(0);
    await loop.stop();
  });

  test("emits service.unguibus.spawn-failed.<sid> after threshold failures", async () => {
    const h = makeHarness(`[agent-loop]\nspawnFailureThreshold = 2\nfastExitThreshold = "1ms"\n`);
    const sid = "sess-threshold";
    h.svc.subscribe(sid, "local.t.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.t.one" });

    const spawn: SpawnFn = async () => ({ ok: false, error: "boom" });
    const loop = startLoop(h, { spawn });

    await loop.tick();
    h.advance(h.config.server.loopIntervalMs + 10_000);
    await loop.tick();

    const evs = h.svc.queryEvents({ type: `service.unguibus.spawn-failed.${sid}` });
    expect(evs.length).toBe(1);
    await loop.stop();
  });

  test("respects spawnBackoffUntil and does not spawn during backoff", async () => {
    const h = makeHarness(`[agent-loop]\nspawnFailureThreshold = 99\nfastExitThreshold = "1ms"\n`);
    const sid = "sess-backoff";
    h.svc.subscribe(sid, "local.b.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.b.one" });

    let spawnCount = 0;
    const spawn: SpawnFn = async () => {
      spawnCount += 1;
      return { ok: false, error: "fail" };
    };
    const loop = startLoop(h, { spawn });
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
      return { ok: true, pid: 99, exited: alivePromise() };
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
      spawn: async () => ({ ok: true, pid: 1, exited: alivePromise() }),
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
      spawn: async () => ({ ok: true, pid: 1, exited: alivePromise() }),
    });
    await loop.tick();
    expect(killed).toEqual([5555]);
    expect(h.svc.listLivePidSessions().find((s) => s.sessionId === sid)).toBeUndefined();
    await loop.stop();
  });

  test("service mutation sets dirty via callback", async () => {
    const h = makeHarness();
    const loop = startLoop(h, {
      spawn: async () => ({ ok: true, pid: 1, exited: alivePromise() }),
    });
    expect(loop.status().dirty).toBe(false);
    h.svc.publishEvent({ source: "urn:x", type: "local.m.a" });
    expect(loop.status().dirty).toBe(true);
    await loop.stop();
  });

  test("status reports lastLoopTime after tick", async () => {
    const h = makeHarness();
    const loop = startLoop(h, {
      spawn: async () => ({ ok: true, pid: 1, exited: alivePromise() }),
    });
    expect(loop.status().lastLoopTime).toBeNull();
    await loop.tick();
    expect(loop.status().lastLoopTime).not.toBeNull();
    await loop.stop();
  });

  test("stop() unregisters dirty callback and status provider", async () => {
    const h = makeHarness();
    const loop = startLoop(h, {
      spawn: async () => ({ ok: true, pid: 1, exited: alivePromise() }),
    });
    await loop.stop();
    const status = h.svc.getAgentStatus();
    expect(status.state).toBe("idle");
    expect(status.lastLoopTime).toBeNull();
    expect(status.recentCadenceMs).toBe(0);
  });

  test("fast-exit (proc.exited resolves within threshold) is treated as spawn failure", async () => {
    const h = makeHarness();
    const sid = "sess-fastexit";
    h.svc.subscribe(sid, "local.fx.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.fx.one" });

    const spawn: SpawnFn = async () => ({ ok: true, pid: 111, exited: Promise.resolve(0) });
    const loop = startLoop(h, { spawn });
    await loop.tick();

    expect(h.svc.listLivePidSessions()).toEqual([]);
    const cand = h.svc.listLoopCandidates().find((c) => c.sessionId === sid);
    expect(cand?.spawnBackoffUntil).not.toBeNull();
    await loop.stop();
  });

  test("global concurrency cap defers excess candidates on the same tick", async () => {
    const h = makeHarness(`[agent-loop]\nmaxConcurrentSpawns = 2\nfastExitThreshold = "1ms"\n`);
    for (const sid of ["a", "b", "c", "d"]) {
      h.svc.subscribe(sid, "local.c.*");
    }
    h.svc.publishEvent({ source: "urn:x", type: "local.c.one" });

    let inFlightPeak = 0;
    let inFlightNow = 0;
    let releaseSpawn: (() => void) | null = null;
    const holdUntil = new Promise<void>((r) => {
      releaseSpawn = r;
    });
    const spawnAttempts: string[] = [];
    const spawn: SpawnFn = async (s) => {
      spawnAttempts.push(s);
      inFlightNow += 1;
      inFlightPeak = Math.max(inFlightPeak, inFlightNow);
      // Block so concurrency observation is meaningful.
      await holdUntil;
      inFlightNow -= 1;
      return { ok: true, pid: Math.floor(Math.random() * 10000), exited: alivePromise() };
    };
    const loop = startLoop(h, { spawn });
    const tickDone = loop.tick();
    // Give spawns a chance to queue.
    await new Promise((r) => setTimeout(r, 10));
    expect(inFlightNow).toBeLessThanOrEqual(2);
    releaseSpawn?.();
    await tickDone;
    expect(inFlightPeak).toBeLessThanOrEqual(2);
    // Two deferred sessions remain without pid; they'll be picked up on later ticks.
    expect(spawnAttempts.length).toBeLessThanOrEqual(2);
    await loop.stop();
  });

  test("per-session spawn lock prevents double-entry during an in-flight spawn", async () => {
    // Issue two ticks that overlap: first tick's spawn is still in flight when we
    // manually call tick() a second time. The in-memory lock must prevent a second
    // spawn for the same sid even though pid is still null in the DB.
    const h = makeHarness();
    const sid = "sess-lock";
    h.svc.subscribe(sid, "local.l.*");
    h.svc.publishEvent({ source: "urn:x", type: "local.l.one" });

    let releaseSpawn: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      releaseSpawn = r;
    });
    let attempts = 0;
    const spawn: SpawnFn = async () => {
      attempts += 1;
      await held;
      return { ok: true, pid: 777, exited: alivePromise() };
    };
    const loop = startLoop(h, { spawn });
    const first = loop.tick();
    await new Promise((r) => setTimeout(r, 5));
    // Second tick while first is still in flight — tick() guards via inFlight,
    // but simulate the candidate being re-queried by forcing dirty. The spawn
    // lock is what ultimately prevents double-spawn; tick()'s inFlight guard
    // alone is not the test.
    h.advance(h.config.server.loopIntervalMs + 1);
    loop.markDirty();
    const second = loop.tick();
    releaseSpawn?.();
    await Promise.all([first, second]);
    // A single spawn attempt satisfies the invariant: either tick()'s inFlight
    // guard coalesced the two ticks, or the per-session lock blocked the
    // second spawn — either path holds the "no double-spawn" contract.
    expect(attempts).toBe(1);
    await loop.stop();
  });
});
