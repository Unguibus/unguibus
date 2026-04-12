import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../config/config.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "../service/service.ts";
import { startConnectorLoop } from "./loop.ts";

describe("startConnectorLoop", () => {
  test("first tick runs the connector, next tick within interval does not", async () => {
    const db = openDb(":memory:");
    const config = parseConfigText(`
[[connectors]]
name = "hello"
command = "echo hello"
interval = "1s"
timeout = "5s"
type = "local.test.hello"
`);
    const svc = new Service(db, config);
    let t = 1_700_000_000_000;
    const loop = startConnectorLoop(svc, db, config, {
      autoStart: false,
      nowMs: () => t,
    });
    try {
      await loop.tick();
      await new Promise((r) => setTimeout(r, 50));
      const state1 = db
        .query<{ lastRunTime: string | null }, [string]>(
          "SELECT lastRunTime FROM connector_state WHERE name = ?",
        )
        .get("hello");
      expect(state1?.lastRunTime).toBeTruthy();
      const first = state1?.lastRunTime;

      t += 500;
      await loop.tick();
      await new Promise((r) => setTimeout(r, 50));
      const state2 = db
        .query<{ lastRunTime: string | null }, [string]>(
          "SELECT lastRunTime FROM connector_state WHERE name = ?",
        )
        .get("hello");
      expect(state2?.lastRunTime).toBe(first ?? null);
    } finally {
      await loop.stop();
      db.close();
    }
  });

  test("tick after interval elapsed re-runs the connector", async () => {
    const db = openDb(":memory:");
    const config = parseConfigText(`
[[connectors]]
name = "hello"
command = "echo hello"
interval = "1s"
timeout = "5s"
type = "local.test.hello"
`);
    const svc = new Service(db, config);
    let t = 1_700_000_000_000;
    const loop = startConnectorLoop(svc, db, config, {
      autoStart: false,
      nowMs: () => t,
    });
    try {
      await loop.tick();
      await new Promise((r) => setTimeout(r, 50));
      const first = db
        .query<{ lastRunTime: string }, [string]>(
          "SELECT lastRunTime FROM connector_state WHERE name = ?",
        )
        .get("hello")?.lastRunTime;
      t += 1500;
      await loop.tick();
      await new Promise((r) => setTimeout(r, 50));
      const second = db
        .query<{ lastRunTime: string }, [string]>(
          "SELECT lastRunTime FROM connector_state WHERE name = ?",
        )
        .get("hello")?.lastRunTime;
      expect(second).not.toBe(first);
    } finally {
      await loop.stop();
      db.close();
    }
  });

  test("stop waits for in-flight runs", async () => {
    const db = openDb(":memory:");
    const config = parseConfigText(`
[[connectors]]
name = "slow"
command = "sleep 0.1 && echo done"
interval = "1s"
timeout = "5s"
type = "local.test.slow"
`);
    const svc = new Service(db, config);
    const loop = startConnectorLoop(svc, db, config, { autoStart: false });
    await loop.tick();
    await loop.stop();
    const state = db
      .query<{ lastRunTime: string | null }, [string]>(
        "SELECT lastRunTime FROM connector_state WHERE name = ?",
      )
      .get("slow");
    expect(state?.lastRunTime).toBeTruthy();
    db.close();
  });
});
