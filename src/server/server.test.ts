import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index.ts";

let home: string;
let base: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "unguibus-test-"));
  const started = startServer({ port: 0, home });
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
});
