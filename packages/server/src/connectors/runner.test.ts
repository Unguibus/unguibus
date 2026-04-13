import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorEntry } from "../config/config.ts";
import { parseConfigText } from "../config/config.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "../service/service.ts";
import { getConnectorState, runConnector } from "./runner.ts";

function makeFixture() {
  const db = openDb(":memory:");
  const config = parseConfigText("");
  const svc = new Service(db, config);
  return { db, svc };
}

function makeConnector(overrides: Partial<ConnectorEntry>): ConnectorEntry {
  return {
    name: "test",
    command: "echo hello",
    intervalMs: 1000,
    timeoutMs: 5000,
    type: "local.test.changed",
    source: "urn:unguibus:connector:test",
    ...overrides,
  };
}

describe("runConnector", () => {
  test("first successful run records hash but publishes no event", async () => {
    const { db, svc } = makeFixture();
    const connector = makeConnector({});
    const res = await runConnector(connector, svc, db);
    expect(res.kind).toBe("first-run");
    const state = getConnectorState(db, connector.name);
    expect(state?.lastHash).toBeTruthy();
    expect(state?.consecutiveFailures).toBe(0);
    const events = svc.queryEvents({});
    expect(events.length).toBe(0);
  });

  test("second run with same output is a no-change", async () => {
    const { db, svc } = makeFixture();
    const connector = makeConnector({});
    await runConnector(connector, svc, db);
    const res = await runConnector(connector, svc, db);
    expect(res.kind).toBe("no-change");
    const events = svc.queryEvents({});
    expect(events.length).toBe(0);
  });

  test("change publishes event with connector type and source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unguibus-conn-"));
    try {
      const file = join(dir, "out.txt");
      writeFileSync(file, "one");
      const { db, svc } = makeFixture();
      const connector = makeConnector({
        command: `cat ${file}`,
        type: "local.test.content-changed",
        source: "urn:test:content",
      });
      const first = await runConnector(connector, svc, db);
      expect(first.kind).toBe("first-run");
      writeFileSync(file, "two");
      const second = await runConnector(connector, svc, db);
      expect(second.kind).toBe("changed");
      const events = svc.queryEvents({});
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("local.test.content-changed");
      expect(events[0]?.source).toBe("urn:test:content");
      const data = events[0]?.data as { hash: string; previousHash: string };
      expect(data.hash).toBe(second.hash ?? "");
      expect(data.previousHash).toBe(first.hash ?? "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("failures below threshold do not publish connector-failed", async () => {
    const { db, svc } = makeFixture();
    const connector = makeConnector({ command: "exit 1" });
    const res = await runConnector(connector, svc, db);
    expect(res.kind).toBe("failure");
    expect(res.exitCode).toBe(1);
    const state = getConnectorState(db, connector.name);
    expect(state?.consecutiveFailures).toBe(1);
    const events = svc.queryEvents({});
    expect(events.length).toBe(0);
  });

  test("failure at threshold publishes service.unguibus.connector-failed.<name>", async () => {
    const { db, svc } = makeFixture();
    const connector = makeConnector({ name: "flaky", command: "exit 2" });
    await runConnector(connector, svc, db);
    await runConnector(connector, svc, db);
    const third = await runConnector(connector, svc, db);
    expect(third.kind).toBe("failure");
    const events = svc.queryEvents({ type: "service.unguibus.connector-failed.flaky" });
    expect(events.length).toBe(1);
    const data = events[0]?.data as { exitCode: number; failures: number };
    expect(data.exitCode).toBe(2);
    expect(data.failures).toBe(3);
    const state = getConnectorState(db, connector.name);
    expect(state?.consecutiveFailures).toBe(3);
  });

  test("success after failure resets the failure counter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unguibus-conn-"));
    try {
      const toggle = join(dir, "toggle.sh");
      const flag = join(dir, "first-done");
      writeFileSync(
        toggle,
        `#!/bin/sh\nif [ ! -f ${flag} ]; then touch ${flag}; exit 1; fi\necho ok\n`,
      );
      const { db, svc } = makeFixture();
      const connector = makeConnector({ command: `sh ${toggle}` });
      const fail = await runConnector(connector, svc, db);
      expect(fail.kind).toBe("failure");
      const ok = await runConnector(connector, svc, db);
      expect(ok.kind).toBe("first-run");
      const state = getConnectorState(db, connector.name);
      expect(state?.consecutiveFailures).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("timeout is treated as failure", async () => {
    const { db, svc } = makeFixture();
    const connector = makeConnector({ command: "sleep 5", timeoutMs: 50 });
    const res = await runConnector(connector, svc, db);
    expect(res.kind).toBe("failure");
    const state = getConnectorState(db, connector.name);
    expect(state?.consecutiveFailures).toBe(1);
  });
});
