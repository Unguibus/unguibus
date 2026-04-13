import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index.ts";

let home: string;
let base: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "unguibus-test-"));
  const started = startServer({ port: 0, home, runAgentLoop: false });
  base = started.url;
  stopServer = started.stop;
});

afterAll(async () => {
  await stopServer();
  rmSync(home, { recursive: true, force: true });
});

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`${base}${path}`, init);
  if (res.status === 204) return { status: 204, json: null };
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("REST server", () => {
  test("GET / returns health", async () => {
    const { status, json } = await req("GET", "/");
    expect(status).toBe(200);
    const body = json as { status: string; version: string; uptimeSeconds: number };
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  test("POST /events returns 201 then 200 on idempotent repeat", async () => {
    const first = await req("POST", "/events", {
      source: "urn:test",
      type: "local.test.round-trip",
      data: { x: 1 },
      id: "rt-1",
    });
    expect(first.status).toBe(201);
    const second = await req("POST", "/events", {
      source: "urn:test",
      type: "local.test.round-trip",
      data: { x: 1 },
      id: "rt-1",
    });
    expect(second.status).toBe(200);
  });

  test("POST /events rejects missing content-type", async () => {
    const res = await fetch(`${base}/events`, {
      method: "POST",
      body: JSON.stringify({ source: "urn:x", type: "local.a.b" }),
    });
    expect(res.status).toBe(415);
  });

  test("subscribe + publish + pending round-trip", async () => {
    const sid = "sess-round";
    const sub = await req("POST", `/sessions/${sid}/subscriptions`, {
      pattern: "local.rr.*",
    });
    expect(sub.status).toBe(204);
    const pub = await req("POST", "/events", {
      source: "urn:round",
      type: "local.rr.hello",
    });
    expect(pub.status).toBe(201);
    const other = await req("POST", "/events", {
      source: "urn:round",
      type: "local.other.nope",
    });
    expect(other.status).toBe(201);
    const pending = await req("GET", `/events/pending/${sid}`);
    const events = (pending.json as { events: { type: string }[] }).events;
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("local.rr.hello");

    const claim = await req("POST", `/events/pending/${sid}/claim`);
    const claimed = (claim.json as { events: unknown[] }).events;
    expect(claimed.length).toBe(1);

    const again = await req("POST", `/events/pending/${sid}/claim`);
    expect((again.json as { events: unknown[] }).events.length).toBe(0);
  });

  test("validation errors return shaped JSON", async () => {
    const bad = await req("POST", "/events", {
      source: "urn:test",
      type: "bad type!",
    });
    expect(bad.status).toBe(400);
    const body = bad.json as { error: string; message: string };
    expect(body.error).toBe("invalid_type");
  });

  test("unknown route returns 404", async () => {
    const res = await req("GET", "/nope");
    expect(res.status).toBe(404);
  });

  test("POST /hooks/:hookName/:sessionId (non-delivery) returns 204", async () => {
    const sid = "sess-hook-1";
    const res = await req("POST", `/hooks/PostToolUse/${sid}`, { tool: "Edit" });
    expect(res.status).toBe(204);
    const evs = await req("GET", `/events?type=agent.claude.post-tool-use.${sid}`);
    const events = (evs.json as { events: { type: string }[] }).events;
    expect(events.length).toBe(1);
  });

  test("POST /hooks/:hookName/:sessionId (delivery) returns 200 with additionalContext", async () => {
    const sid = "sess-hook-2";
    await req("POST", `/sessions/${sid}/subscriptions`, { pattern: "local.hook.*" });
    await req("POST", "/events", { source: "urn:ext", type: "local.hook.ping" });
    const res = await req("POST", `/hooks/SessionStart/${sid}`, { ppid: 12345 });
    expect(res.status).toBe(200);
    const body = res.json as { additionalContext: string };
    expect(body.additionalContext).toContain("1 new event");
    expect(body.additionalContext).toContain("local.hook.ping");
  });

  test("GET /agent-status returns placeholder shape", async () => {
    const { status, json } = await req("GET", "/agent-status");
    expect(status).toBe(200);
    const body = json as {
      state: string;
      currentSessionId: string | null;
      dirty: boolean;
      lastLoopTime: string | null;
      recentCadenceMs: number;
    };
    expect(body.state).toBe("idle");
    expect(body.currentSessionId).toBeNull();
    expect(body.dirty).toBe(false);
    expect(body.lastLoopTime).toBeNull();
    expect(body.recentCadenceMs).toBe(0);
  });

  test("GET /queues aggregates per (session, pattern) pending counts", async () => {
    const sid = "sess-queue";
    await req("POST", `/sessions/${sid}/subscriptions`, { pattern: "local.q.*" });
    await req("POST", "/events", { source: "urn:q", type: "local.q.one" });
    await req("POST", "/events", { source: "urn:q", type: "local.q.two" });
    await req("POST", "/events", { source: "urn:q", type: "local.other.ignored" });
    const { status, json } = await req("GET", "/queues");
    expect(status).toBe(200);
    const queues = (json as { queues: unknown[] }).queues as Array<{
      sessionId: string;
      pattern: string;
      pendingCount: number;
      oldestPendingAt: string | null;
    }>;
    const mine = queues.find((q) => q.sessionId === sid && q.pattern === "local.q.*");
    expect(mine).toBeDefined();
    expect(mine?.pendingCount).toBe(2);
    expect(typeof mine?.oldestPendingAt).toBe("string");
  });

  test("GET /subscriptions rollup includes direct subscriptions", async () => {
    const sid = "sess-subs-roll";
    await req("POST", `/sessions/${sid}/subscriptions`, { pattern: "local.roll.*" });
    const { status, json } = await req("GET", "/subscriptions");
    expect(status).toBe(200);
    const entries = (json as { subscriptions: unknown[] }).subscriptions as Array<{
      pattern: string;
      origin: string;
      tag: string | null;
      sessions: Array<{ sessionId: string }>;
    }>;
    const direct = entries.find((e) => e.pattern === "local.roll.*" && e.origin === "direct");
    expect(direct).toBeDefined();
    expect(direct?.tag).toBeNull();
    expect(direct?.sessions.some((s) => s.sessionId === sid)).toBe(true);
  });
});

describe("REST server with connector + tag config", () => {
  let home2: string;
  let base2: string;
  let stop2: () => Promise<void>;

  beforeAll(async () => {
    home2 = mkdtempSync(join(tmpdir(), "unguibus-test-cfg-"));
    writeFileSync(
      join(home2, "config.toml"),
      `[[connectors]]
name = "probe"
command = "echo probe"
interval = "60s"
timeout = "10s"
type = "local.probe.tick"

[[subscriptions]]
pattern = "local.probe.*"
tag = "probe-watcher"
`,
    );
    const started = startServer({ port: 0, home: home2, runConnectors: false });
    base2 = started.url;
    stop2 = started.stop;
  });

  afterAll(async () => {
    await stop2();
    rmSync(home2, { recursive: true, force: true });
  });

  async function req2(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await fetch(`${base2}${path}`, init);
    if (res.status === 204) return { status: 204, json: null };
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  test("GET /connectors returns configured connector joined with (empty) state", async () => {
    const { status, json } = await req2("GET", "/connectors");
    expect(status).toBe(200);
    const connectors = (json as { connectors: unknown[] }).connectors as Array<{
      name: string;
      type: string;
      source: string;
      intervalMs: number;
      timeoutMs: number;
      lastRunTime: string | null;
      lastExitCode: number | null;
      consecutiveFailures: number;
      backoffUntil: string | null;
    }>;
    expect(connectors.length).toBe(1);
    const [probe] = connectors;
    expect(probe?.name).toBe("probe");
    expect(probe?.type).toBe("local.probe.tick");
    expect(probe?.source).toBe("urn:unguibus:connector:probe");
    expect(probe?.intervalMs).toBe(60_000);
    expect(probe?.lastRunTime).toBeNull();
    expect(probe?.lastExitCode).toBeNull();
    expect(probe?.consecutiveFailures).toBe(0);
    expect(probe?.backoffUntil).toBeNull();
  });

  test("GET /subscriptions rollup includes config tag-based subscriptions with tagged sessions", async () => {
    const sid = "sess-tagged";
    const tagRes = await req2("POST", `/sessions/${sid}/tags`, { tag: "probe-watcher" });
    expect(tagRes.status).toBe(204);
    const { status, json } = await req2("GET", "/subscriptions");
    expect(status).toBe(200);
    const entries = (json as { subscriptions: unknown[] }).subscriptions as Array<{
      pattern: string;
      origin: string;
      tag: string | null;
      sessions: Array<{ sessionId: string }>;
    }>;
    const viaTag = entries.find(
      (e) => e.pattern === "local.probe.*" && e.origin === "config" && e.tag === "probe-watcher",
    );
    expect(viaTag).toBeDefined();
    expect(viaTag?.sessions.some((s) => s.sessionId === sid)).toBe(true);
  });
});
