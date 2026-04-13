import type { Database } from "bun:sqlite";
import type { Config, ConnectorEntry } from "../config/config.ts";
import type { Service } from "../service/service.ts";
import { getConnectorState, runConnector } from "./runner.ts";

export interface ConnectorLoop {
  tick: () => Promise<void>;
  stop: () => Promise<void>;
}

export function startConnectorLoop(
  service: Service,
  db: Database,
  config: Config,
  opts?: { autoStart?: boolean; nowMs?: () => number },
): ConnectorLoop {
  const nowMs = opts?.nowMs ?? Date.now;
  const nowIso = () => new Date(nowMs()).toISOString();
  const inflight = new Map<string, Promise<void>>();
  const abortController = new AbortController();
  let stopped = false;

  const shouldRun = (connector: ConnectorEntry): boolean => {
    if (stopped) return false;
    if (inflight.has(connector.name)) return false;
    const state = getConnectorState(db, connector.name);
    if (!state?.lastRunTime) return true;
    const last = new Date(state.lastRunTime).getTime();
    if (Number.isNaN(last)) return true;
    return nowMs() - last >= connector.intervalMs;
  };

  const kick = (connector: ConnectorEntry): void => {
    if (!shouldRun(connector)) return;
    const p = runConnector(connector, service, db, {
      abortSignal: abortController.signal,
      nowIso,
    })
      .then(() => undefined)
      .catch((err) => {
        console.error(`[connector:${connector.name}] unhandled error`, err);
      })
      .finally(() => {
        inflight.delete(connector.name);
      });
    inflight.set(connector.name, p);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    for (const connector of config.connectors) {
      kick(connector);
    }
  };

  let interval: ReturnType<typeof setInterval> | null = null;
  if (opts?.autoStart !== false) {
    interval = setInterval(() => {
      void tick();
    }, config.server.connectorTickIntervalMs);
    void tick();
  }

  return {
    tick,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (interval !== null) clearInterval(interval);
      const deadlineMs = config.server.connectorShutdownTimeoutMs;
      const pending = [...inflight.values()];
      if (pending.length === 0) return;
      const allDone = Promise.allSettled(pending);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlineReached = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      });
      await Promise.race([allDone, deadlineReached]);
      if (timer !== undefined) clearTimeout(timer);
      if (inflight.size > 0) {
        abortController.abort();
        await Promise.allSettled([...inflight.values()]);
      }
    },
  };
}
