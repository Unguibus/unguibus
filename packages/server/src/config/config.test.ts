import { describe, expect, test } from "bun:test";
import { parseConfigText } from "./config.ts";

describe("parseConfigText", () => {
  test("empty input yields defaults", () => {
    const cfg = parseConfigText("");
    expect(cfg.server.port).toBe(47666);
    expect(cfg.server.loopIntervalMs).toBe(3_000);
    expect(cfg.retention.defaultTtlMs).toBe(48 * 3_600_000);
    expect(cfg.subscriptions).toEqual([]);
    expect(cfg.connectors).toEqual([]);
  });

  test("parses subscriptions + connectors", () => {
    const cfg = parseConfigText(`
[server]
port = 47777

[[subscriptions]]
pattern = "service.github.pr-updated.unguibus.*.*"
tag = "pr-reviewer"

[[connectors]]
name = "gh-designs"
command = "gh api repos/Unguibus/designs/commits?per_page=1"
interval = "5m"
type = "service.github.repo-updated.unguibus.designs"
`);
    expect(cfg.server.port).toBe(47777);
    expect(cfg.subscriptions[0]?.pattern).toBe("service.github.pr-updated.unguibus.*.*");
    expect(cfg.connectors[0]?.intervalMs).toBe(5 * 60_000);
    expect(cfg.connectors[0]?.source).toBe("urn:unguibus:connector:gh-designs");
  });

  test("rejects warnAfter >= killAfter", () => {
    expect(() =>
      parseConfigText(`
[watchdog]
warnAfter = "30m"
killAfter = "30m"
`),
    ).toThrow(/warnAfter/);
  });

  test("rejects reserved connector type", () => {
    expect(() =>
      parseConfigText(`
[[connectors]]
name = "x"
command = "echo"
interval = "1m"
type = "service.unguibus.foo"
`),
    ).toThrow(/reserved/);
  });

  test("rejects invalid pattern", () => {
    expect(() =>
      parseConfigText(`
[[subscriptions]]
pattern = "bad pattern"
tag = "t"
`),
    ).toThrow(/pattern/);
  });

  test("[agent-loop] defaults match design", () => {
    const cfg = parseConfigText("");
    expect(cfg.agentLoop.fastExitThresholdMs).toBe(5_000);
    expect(cfg.agentLoop.maxConcurrentSpawns).toBe(4);
    expect(cfg.agentLoop.spawnFailureThreshold).toBe(3);
  });

  test("[agent-loop] accepts overrides", () => {
    const cfg = parseConfigText(`
[agent-loop]
fastExitThreshold = "2s"
maxConcurrentSpawns = 8
spawnFailureThreshold = 5
`);
    expect(cfg.agentLoop.fastExitThresholdMs).toBe(2_000);
    expect(cfg.agentLoop.maxConcurrentSpawns).toBe(8);
    expect(cfg.agentLoop.spawnFailureThreshold).toBe(5);
  });

  test("[agent-loop] rejects maxConcurrentSpawns < 1", () => {
    expect(() =>
      parseConfigText(`
[agent-loop]
maxConcurrentSpawns = 0
`),
    ).toThrow(/maxConcurrentSpawns/);
  });
});
