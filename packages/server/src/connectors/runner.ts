import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ConnectorEntry } from "../config/config.ts";
import type { Service } from "../service/service.ts";

const DEFAULT_FAILURE_THRESHOLD = 3;
const STDERR_TAIL_BYTES = 4 * 1024;

export interface ConnectorStateRow {
  name: string;
  lastHash: string | null;
  lastRunTime: string | null;
  consecutiveFailures: number;
  lastExitCode: number | null;
}

export interface ConnectorRunResult {
  kind: "no-change" | "changed" | "first-run" | "failure";
  hash?: string;
  previousHash?: string | null;
  exitCode?: number;
  stderrTail?: string;
}

export function getConnectorState(db: Database, name: string): ConnectorStateRow | null {
  return (
    db
      .query<ConnectorStateRow, [string]>("SELECT * FROM connector_state WHERE name = ?")
      .get(name) ?? null
  );
}

function upsertState(
  db: Database,
  name: string,
  patch: {
    lastHash?: string;
    lastRunTime: string;
    consecutiveFailures: number;
    lastExitCode: number | null;
  },
): void {
  const existing = getConnectorState(db, name);
  if (existing === null) {
    db.query(
      "INSERT INTO connector_state (name, lastHash, lastRunTime, consecutiveFailures, lastExitCode) VALUES (?, ?, ?, ?, ?)",
    ).run(
      name,
      patch.lastHash ?? null,
      patch.lastRunTime,
      patch.consecutiveFailures,
      patch.lastExitCode,
    );
    return;
  }
  const hash = patch.lastHash === undefined ? existing.lastHash : patch.lastHash;
  db.query(
    "UPDATE connector_state SET lastHash = ?, lastRunTime = ?, consecutiveFailures = ?, lastExitCode = ? WHERE name = ?",
  ).run(hash, patch.lastRunTime, patch.consecutiveFailures, patch.lastExitCode, name);
}

async function drainWithinMs(stream: ReadableStream<Uint8Array>, ms: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([done, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return Buffer.from(out);
}

async function runOnce(
  connector: ConnectorEntry,
  abortSignal: AbortSignal,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; timedOut: boolean }> {
  const proc = Bun.spawn(["sh", "-c", connector.command], {
    stdout: "pipe",
    stderr: "pipe",
    signal: abortSignal,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, connector.timeoutMs);
  try {
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const drainMs = timedOut ? 100 : 2000;
    const [stdout, stderr] = await Promise.all([
      drainWithinMs(proc.stdout, drainMs),
      drainWithinMs(proc.stderr, drainMs),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } catch (err) {
    clearTimeout(timer);
    if (abortSignal.aborted) {
      return {
        exitCode: 124,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
        timedOut: true,
      };
    }
    throw err;
  }
}

export async function runConnector(
  connector: ConnectorEntry,
  service: Service,
  db: Database,
  opts?: { nowIso?: () => string; abortSignal?: AbortSignal },
): Promise<ConnectorRunResult> {
  const nowIso = opts?.nowIso ?? (() => new Date().toISOString());
  const abortSignal = opts?.abortSignal ?? new AbortController().signal;

  let result: Awaited<ReturnType<typeof runOnce>>;
  try {
    result = await runOnce(connector, abortSignal);
  } catch (err) {
    const state = getConnectorState(db, connector.name);
    const failures = (state?.consecutiveFailures ?? 0) + 1;
    upsertState(db, connector.name, {
      lastRunTime: nowIso(),
      consecutiveFailures: failures,
      lastExitCode: -1,
    });
    maybePublishConnectorFailed(service, connector, failures, -1, String(err));
    return {
      kind: "failure",
      exitCode: -1,
      stderrTail: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.exitCode !== 0 || result.timedOut) {
    const state = getConnectorState(db, connector.name);
    const failures = (state?.consecutiveFailures ?? 0) + 1;
    upsertState(db, connector.name, {
      lastRunTime: nowIso(),
      consecutiveFailures: failures,
      lastExitCode: result.exitCode,
    });
    const stderrTail = tailBuffer(result.stderr, STDERR_TAIL_BYTES);
    maybePublishConnectorFailed(service, connector, failures, result.exitCode, stderrTail);
    return { kind: "failure", exitCode: result.exitCode, stderrTail };
  }

  const hash = createHash("sha256").update(result.stdout).digest("hex");
  const state = getConnectorState(db, connector.name);
  const previousHash = state?.lastHash ?? null;
  upsertState(db, connector.name, {
    lastHash: hash,
    lastRunTime: nowIso(),
    consecutiveFailures: 0,
    lastExitCode: 0,
  });

  if (previousHash === null) return { kind: "first-run", hash };
  if (previousHash === hash) return { kind: "no-change", hash };

  service.publishEvent({
    source: connector.source,
    type: connector.type,
    data: { hash, previousHash, at: nowIso() },
  });
  return { kind: "changed", hash, previousHash };
}

function tailBuffer(buf: Buffer, maxBytes: number): string {
  const slice = buf.byteLength > maxBytes ? buf.subarray(buf.byteLength - maxBytes) : buf;
  return slice.toString("utf8");
}

function maybePublishConnectorFailed(
  service: Service,
  connector: ConnectorEntry,
  failures: number,
  exitCode: number,
  stderrTail: string,
): void {
  if (failures < DEFAULT_FAILURE_THRESHOLD) return;
  service.publishServiceEvent({
    source: "urn:unguibus:server",
    type: `service.unguibus.connector-failed.${connector.name}`,
    data: { exitCode, stderrTail, failures },
  });
}
