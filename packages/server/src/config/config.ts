import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { parseDurationMs } from "./duration.ts";
import { isReservedType, isValidConnectorName, isValidPattern, isValidType } from "./grammar.ts";

export interface SubscriptionEntry {
  pattern: string;
  tag: string;
}

export interface ConnectorEntry {
  name: string;
  command: string;
  intervalMs: number;
  timeoutMs: number;
  type: string;
  source: string;
}

export interface Config {
  server: {
    port: number;
    loopIntervalMs: number;
    backoffFactor: number;
    maxEventsPerDelivery: number;
    configReloadIntervalMs: number;
    connectorTickIntervalMs: number;
    connectorShutdownTimeoutMs: number;
  };
  retention: {
    defaultTtlMs: number;
    sessionTtlMs: number;
    pruneIntervalMs: number;
  };
  watchdog: {
    warnAfterMs: number;
    killAfterMs: number;
  };
  agentLoop: {
    fastExitThresholdMs: number;
    maxConcurrentSpawns: number;
    spawnFailureThreshold: number;
  };
  subscriptions: SubscriptionEntry[];
  connectors: ConnectorEntry[];
}

const DEFAULTS = {
  server: {
    port: 47666,
    loopInterval: "3s",
    backoffFactor: 1.0,
    maxEventsPerDelivery: 50,
    configReloadInterval: "30s",
    connectorTickInterval: "1s",
    connectorShutdownTimeout: "5s",
  },
  retention: {
    defaultTTL: "48h",
    sessionTTL: "30d",
    pruneInterval: "5m",
  },
  watchdog: {
    warnAfter: "20m",
    killAfter: "30m",
  },
  agentLoop: {
    fastExitThreshold: "5s",
    maxConcurrentSpawns: 4,
    spawnFailureThreshold: 3,
  },
} as const;

function asDuration(value: unknown, fallback: string): number {
  return parseDurationMs(typeof value === "string" ? value : fallback);
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return fallback;
}

export function loadConfig(configFile: string): Config {
  const rawText = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  return parseConfigText(rawText);
}

export function parseConfigText(text: string): Config {
  const raw = (text.trim().length === 0 ? {} : parseToml(text)) as Record<string, unknown>;
  const serverRaw = (raw.server ?? {}) as Record<string, unknown>;
  const retentionRaw = (raw.retention ?? {}) as Record<string, unknown>;
  const watchdogRaw = (raw.watchdog ?? {}) as Record<string, unknown>;
  const agentLoopRaw = (raw["agent-loop"] ?? raw.agentLoop ?? {}) as Record<string, unknown>;
  const subsRaw = (raw.subscriptions ?? []) as unknown[];
  const connectorsRaw = (raw.connectors ?? []) as unknown[];

  const cfg: Config = {
    server: {
      port: asNumber(serverRaw.port, DEFAULTS.server.port),
      loopIntervalMs: asDuration(serverRaw.loopInterval, DEFAULTS.server.loopInterval),
      backoffFactor: asNumber(serverRaw.backoffFactor, DEFAULTS.server.backoffFactor),
      maxEventsPerDelivery: asNumber(
        serverRaw.maxEventsPerDelivery,
        DEFAULTS.server.maxEventsPerDelivery,
      ),
      configReloadIntervalMs: asDuration(
        serverRaw.configReloadInterval,
        DEFAULTS.server.configReloadInterval,
      ),
      connectorTickIntervalMs: asDuration(
        serverRaw.connectorTickInterval,
        DEFAULTS.server.connectorTickInterval,
      ),
      connectorShutdownTimeoutMs: asDuration(
        serverRaw.connectorShutdownTimeout,
        DEFAULTS.server.connectorShutdownTimeout,
      ),
    },
    retention: {
      defaultTtlMs: asDuration(retentionRaw.defaultTTL, DEFAULTS.retention.defaultTTL),
      sessionTtlMs: asDuration(retentionRaw.sessionTTL, DEFAULTS.retention.sessionTTL),
      pruneIntervalMs: asDuration(retentionRaw.pruneInterval, DEFAULTS.retention.pruneInterval),
    },
    watchdog: {
      warnAfterMs: asDuration(watchdogRaw.warnAfter, DEFAULTS.watchdog.warnAfter),
      killAfterMs: asDuration(watchdogRaw.killAfter, DEFAULTS.watchdog.killAfter),
    },
    agentLoop: {
      fastExitThresholdMs: asDuration(
        agentLoopRaw.fastExitThreshold,
        DEFAULTS.agentLoop.fastExitThreshold,
      ),
      maxConcurrentSpawns: asNumber(
        agentLoopRaw.maxConcurrentSpawns,
        DEFAULTS.agentLoop.maxConcurrentSpawns,
      ),
      spawnFailureThreshold: asNumber(
        agentLoopRaw.spawnFailureThreshold,
        DEFAULTS.agentLoop.spawnFailureThreshold,
      ),
    },
    subscriptions: [],
    connectors: [],
  };

  if (cfg.watchdog.warnAfterMs >= cfg.watchdog.killAfterMs) {
    throw new Error(
      "[watchdog] warnAfter must be strictly less than killAfter (otherwise the warning never fires)",
    );
  }
  if (cfg.agentLoop.maxConcurrentSpawns < 1) {
    throw new Error("[agent-loop] maxConcurrentSpawns must be >= 1");
  }
  if (cfg.agentLoop.spawnFailureThreshold < 1) {
    throw new Error("[agent-loop] spawnFailureThreshold must be >= 1");
  }
  if (cfg.agentLoop.fastExitThresholdMs < 0) {
    throw new Error("[agent-loop] fastExitThreshold must be >= 0");
  }

  for (const entry of subsRaw) {
    const s = entry as Record<string, unknown>;
    const pattern = typeof s.pattern === "string" ? s.pattern : "";
    const tag = typeof s.tag === "string" ? s.tag : "";
    if (!isValidPattern(pattern)) {
      throw new Error(`[[subscriptions]] invalid pattern: ${JSON.stringify(pattern)}`);
    }
    if (tag.length === 0) {
      throw new Error(`[[subscriptions]] missing tag for pattern ${JSON.stringify(pattern)}`);
    }
    cfg.subscriptions.push({ pattern, tag });
  }

  const seenNames = new Set<string>();
  for (const entry of connectorsRaw) {
    const c = entry as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name : "";
    const command = typeof c.command === "string" ? c.command : "";
    const type = typeof c.type === "string" ? c.type : "";
    const source = typeof c.source === "string" ? c.source : `urn:unguibus:connector:${name}`;
    const intervalMs = asDuration(c.interval, "60s");
    const timeoutMs = asDuration(c.timeout, "30s");
    if (!isValidConnectorName(name)) {
      throw new Error(`[[connectors]] invalid name: ${JSON.stringify(name)}`);
    }
    if (seenNames.has(name)) {
      throw new Error(`[[connectors]] duplicate name: ${JSON.stringify(name)}`);
    }
    seenNames.add(name);
    if (command.length === 0) {
      throw new Error(`[[connectors]] ${name}: missing command`);
    }
    if (!isValidType(type) || isReservedType(type)) {
      throw new Error(`[[connectors]] ${name}: invalid or reserved type ${JSON.stringify(type)}`);
    }
    cfg.connectors.push({ name, command, intervalMs, timeoutMs, type, source });
  }

  return cfg;
}
