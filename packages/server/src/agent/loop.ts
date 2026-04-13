import type { Config } from "../config/config.ts";
import { formatEvents } from "../hooks/format.ts";
import type { Service } from "../service/service.ts";
import type { AgentStatus, LoopCandidate, StoredEvent } from "../service/types.ts";
import { killPid as defaultKillPid, isProcessAlive } from "./pid.ts";

const SPAWN_BACKOFF_CAP_MS = 60 * 60 * 1000;
const DEFAULT_SPAWN_FAILURE_THRESHOLD = 3;
const CADENCE_WINDOW = 20;

export interface SpawnResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export type SpawnFn = (sessionId: string, prompt: string) => Promise<SpawnResult>;

export interface AgentLoopOptions {
  autoStart?: boolean;
  nowMs?: () => number;
  spawn?: SpawnFn;
  checkAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => Promise<void>;
  spawnFailureThreshold?: number;
  tickIntervalMs?: number;
}

export interface AgentLoop {
  tick: () => Promise<void>;
  stop: () => Promise<void>;
  markDirty: () => void;
  status: () => AgentStatus;
}

const defaultSpawn: SpawnFn = async (sessionId, prompt) => {
  try {
    const proc = Bun.spawn(["claude", "--resume", sessionId, "-p", prompt], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pid = proc.pid;
    if (typeof pid !== "number" || pid <= 0) {
      return { ok: false, error: "spawn returned no pid" };
    }
    proc.unref?.();
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export function startAgentLoop(
  service: Service,
  config: Config,
  opts: AgentLoopOptions = {},
): AgentLoop {
  const nowMs = opts.nowMs ?? Date.now;
  const spawn = opts.spawn ?? defaultSpawn;
  const checkAlive = opts.checkAlive ?? isProcessAlive;
  const killPid = opts.killPid ?? defaultKillPid;
  const threshold = opts.spawnFailureThreshold ?? DEFAULT_SPAWN_FAILURE_THRESHOLD;

  let dirty = false;
  let lastLoopTime: number | null = null;
  let currentSessionId: string | null = null;
  let state: "idle" | "running" = "idle";
  let backoffMs = 0;
  const cadenceSamples: number[] = [];
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const status = (): AgentStatus => ({
    state,
    currentSessionId,
    dirty,
    lastLoopTime: lastLoopTime === null ? null : new Date(lastLoopTime).toISOString(),
    recentCadenceMs:
      cadenceSamples.length === 0
        ? 0
        : Math.round(cadenceSamples.reduce((a, b) => a + b, 0) / cadenceSamples.length),
  });

  service.setDirtyCallback(() => {
    dirty = true;
  });
  service.setAgentStatusProvider(status);

  const processCandidate = async (candidate: LoopCandidate): Promise<void> => {
    if (candidate.pid !== null) {
      if (checkAlive(candidate.pid)) return;
      service.cleanupKilledSession(candidate.sessionId);
    }
    if (candidate.spawnBackoffUntil !== null) {
      const until = new Date(candidate.spawnBackoffUntil).getTime();
      if (Number.isFinite(until) && until > nowMs()) return;
    }

    const all = service.getLoopPendingEvents(candidate.sessionId);
    if (all.length === 0) return;

    const cap = config.server.maxEventsPerDelivery;
    let capped: StoredEvent[];
    let advanceTo: string;
    if (all.length > cap) {
      capped = all.slice(0, cap);
      const next = all[cap];
      if (!next) {
        advanceTo = capped[capped.length - 1]?.publishedAt ?? new Date(nowMs()).toISOString();
      } else {
        const t = new Date(next.publishedAt).getTime() - 1;
        advanceTo = new Date(t).toISOString();
      }
    } else {
      capped = all;
      advanceTo = capped[capped.length - 1]?.publishedAt ?? new Date(nowMs()).toISOString();
    }

    service.setPendingWatermark(candidate.sessionId, advanceTo);

    currentSessionId = candidate.sessionId;
    state = "running";
    try {
      const prompt = formatEvents(capped, new Date(nowMs()));
      const result = await spawn(candidate.sessionId, prompt);
      if (result.ok && typeof result.pid === "number") {
        service.recordSpawnSuccess(candidate.sessionId, result.pid);
      } else {
        const failure = service.recordSpawnFailure(candidate.sessionId, SPAWN_BACKOFF_CAP_MS);
        if (failure.spawnFailures === threshold) {
          try {
            service.publishServiceEvent({
              source: "urn:unguibus:server",
              type: `service.unguibus.spawn-failed.${candidate.sessionId}`,
              data: {
                sessionId: candidate.sessionId,
                spawnFailures: failure.spawnFailures,
                error: result.error ?? "unknown spawn failure",
              },
            });
          } catch (err) {
            console.error(`[agent-loop] failed to publish spawn-failed event: ${String(err)}`);
          }
        }
      }
    } finally {
      state = "idle";
      currentSessionId = null;
    }
  };

  const runWatchdog = async (): Promise<void> => {
    const now = nowMs();
    const warnMs = config.watchdog.warnAfterMs;
    const killMs = config.watchdog.killAfterMs;
    for (const live of service.listLivePidSessions()) {
      const lastHook = live.lastHookTime === null ? null : new Date(live.lastHookTime).getTime();
      if (lastHook === null || !Number.isFinite(lastHook)) continue;
      const idleMs = now - lastHook;
      if (idleMs > killMs) {
        const pid = live.pid;
        const sid = live.sessionId;
        service.cleanupKilledSession(sid);
        void killPid(pid).catch((err) => {
          console.error(`[agent-loop] failed to kill pid ${pid} for ${sid}: ${String(err)}`);
        });
      } else if (idleMs > warnMs && !live.pendingWarning) {
        service.markPendingWarning(live.sessionId);
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return inFlight;

    const idleInterval = config.server.loopIntervalMs;
    const threshold =
      lastLoopTime === null ? 0 : lastLoopTime + (dirty ? 0 : idleInterval) + backoffMs;
    if (nowMs() < threshold) return;

    const wasDirty = dirty;
    dirty = false;
    const start = nowMs();
    if (lastLoopTime !== null) {
      const cadence = start - lastLoopTime;
      cadenceSamples.push(cadence);
      if (cadenceSamples.length > CADENCE_WINDOW) cadenceSamples.shift();
    }
    lastLoopTime = start;

    inFlight = (async () => {
      // wasDirty forces a fresh DB read; DB is the cache since we don't maintain a
      // separate in-memory copy — so "refresh" = re-query inside listLoopCandidates.
      void wasDirty;
      const candidates = service.listLoopCandidates();
      for (const c of candidates) {
        if (stopped) break;
        await processCandidate(c);
      }
      await runWatchdog();

      const elapsed = nowMs() - start;
      const setSize = candidates.length;
      backoffMs = Math.max(0, Math.floor(elapsed * setSize * config.server.backoffFactor));
    })();

    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  let interval: ReturnType<typeof setInterval> | null = null;
  if (opts.autoStart !== false) {
    const tickIntervalMs = opts.tickIntervalMs ?? 100;
    interval = setInterval(() => {
      void tick();
    }, tickIntervalMs);
  }

  return {
    tick,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (interval !== null) clearInterval(interval);
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* ignore */
        }
      }
      service.setDirtyCallback(null);
      service.setAgentStatusProvider(null);
    },
    markDirty: () => {
      dirty = true;
    },
    status,
  };
}
