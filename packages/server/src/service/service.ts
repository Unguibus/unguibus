import type { Database } from "bun:sqlite";
import type { Config } from "../config/config.ts";
import {
  isReservedType,
  isValidEventId,
  isValidPattern,
  isValidType,
  matchesPattern,
} from "../config/grammar.ts";
import {
  type AgentStatus,
  type CloudEvent,
  type ConnectorStatus,
  type LivePidSession,
  type LoopCandidate,
  type PublishInput,
  type PublishResult,
  type QueryInput,
  type QueueStatus,
  ServiceError,
  type SpawnFailureResult,
  type StoredEvent,
  type SubscriptionRollup,
  type SubscriptionSessionInfo,
} from "./types.ts";

interface EventRow {
  id: string;
  source: string;
  type: string;
  time: string;
  publishedAt: string;
  data: string;
}

function rowToStored(row: EventRow): StoredEvent {
  return {
    specversion: "1.0",
    id: row.id,
    source: row.source,
    type: row.type,
    time: row.time,
    datacontenttype: "application/json",
    data: JSON.parse(row.data),
    publishedAt: row.publishedAt,
  };
}

function ensureIso(value: string, field: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ServiceError("invalid_timestamp", `${field} is not a valid ISO-8601 timestamp`);
  }
  return d.toISOString();
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function validateSource(source: unknown): string {
  if (typeof source !== "string" || source.length === 0) {
    throw new ServiceError("invalid_source", "source must be a non-empty URI-reference");
  }
  if (hasControlChar(source)) {
    throw new ServiceError("invalid_source", "source must not contain control characters");
  }
  return source;
}

export class Service {
  readonly db: Database;
  readonly config: Config;
  private nowFn: () => number;
  private dirtyCallback: (() => void) | null = null;
  private agentStatusProvider: (() => AgentStatus) | null = null;

  constructor(db: Database, config: Config, nowFn: () => number = Date.now) {
    this.db = db;
    this.config = config;
    this.nowFn = nowFn;
  }

  private nowIso(): string {
    return new Date(this.nowFn()).toISOString();
  }

  setDirtyCallback(cb: (() => void) | null): void {
    this.dirtyCallback = cb;
  }

  setAgentStatusProvider(provider: (() => AgentStatus) | null): void {
    this.agentStatusProvider = provider;
  }

  private markDirty(): void {
    this.dirtyCallback?.();
  }

  publishEvent(input: PublishInput): PublishResult {
    return this.publishInternal(input, false);
  }

  /**
   * Publish bypassing the reserved-namespace check. Only the server internals
   * (connector-failed, spawn-failed, watchdog events) should call this.
   */
  publishServiceEvent(input: PublishInput): PublishResult {
    return this.publishInternal(input, true);
  }

  private publishInternal(input: PublishInput, allowReserved: boolean): PublishResult {
    if (input.specversion !== undefined && input.specversion !== "1.0") {
      throw new ServiceError(
        "invalid_specversion",
        `specversion must be "1.0" (got ${JSON.stringify(input.specversion)})`,
      );
    }
    if (input.datacontenttype !== undefined && input.datacontenttype !== "application/json") {
      throw new ServiceError(
        "invalid_datacontenttype",
        `datacontenttype must be "application/json" (got ${JSON.stringify(input.datacontenttype)})`,
      );
    }

    const source = validateSource(input.source);
    const type = input.type;
    if (!isValidType(type)) {
      throw new ServiceError("invalid_type", `invalid event type ${JSON.stringify(type)}`);
    }
    if (!allowReserved && isReservedType(type)) {
      throw new ServiceError(
        "reserved_type",
        "type namespace service.unguibus.* is reserved for the unguibus server",
      );
    }

    const id = input.id ?? crypto.randomUUID();
    if (!isValidEventId(id)) {
      throw new ServiceError("invalid_id", "event id must be 1-256 printable ASCII chars");
    }

    const time = input.time !== undefined ? ensureIso(input.time, "time") : this.nowIso();
    const publishedAt = this.nowIso();
    const data = input.data === undefined ? {} : input.data;
    const dataJson = JSON.stringify(data);

    const existing = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    if (existing) {
      return { event: rowToStored(existing), created: false };
    }
    this.db
      .query(
        "INSERT INTO events (id, source, type, time, publishedAt, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, source, type, time, publishedAt, dataJson);
    this.markDirty();
    const event: StoredEvent = {
      specversion: "1.0",
      id,
      source,
      type,
      time,
      datacontenttype: "application/json",
      data,
      publishedAt,
    };
    return { event, created: true };
  }

  queryEvents(input: QueryInput): StoredEvent[] {
    const order: "asc" | "desc" = input.order ?? "desc";
    if (order !== "asc" && order !== "desc") {
      throw new ServiceError("invalid_order", "order must be 'asc' or 'desc'");
    }
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (input.type !== undefined) {
      if (!isValidType(input.type) && !isValidPattern(input.type)) {
        throw new ServiceError("invalid_type", "type filter is not a valid type or pattern");
      }
      if (!input.type.includes("*")) {
        clauses.push("type = ?");
        params.push(input.type);
      }
    }
    if (input.source !== undefined) {
      clauses.push("source = ?");
      params.push(input.source);
    }
    if (input.since !== undefined) {
      clauses.push("publishedAt > ?");
      params.push(ensureIso(input.since, "since"));
    }
    if (input.until !== undefined) {
      clauses.push("publishedAt < ?");
      params.push(ensureIso(input.until, "until"));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderSql = order === "asc" ? "ASC" : "DESC";
    const sql = `SELECT * FROM events ${where} ORDER BY publishedAt ${orderSql}, id ${orderSql}`;
    let rows = this.db.query<EventRow, (string | number)[]>(sql).all(...params);

    if (input.type?.includes("*")) {
      const pattern = input.type;
      rows = rows.filter((r) => matchesPattern(pattern, r.type));
    }

    const offset = input.offset ?? 0;
    if (offset > 0) rows = rows.slice(offset);
    if (input.limit !== undefined && input.limit >= 0) rows = rows.slice(0, input.limit);
    return rows.map(rowToStored);
  }

  private ensureSessionRow(sessionId: string): void {
    this.db
      .query("INSERT OR IGNORE INTO sessions (sessionId, lastHookTime) VALUES (?, ?)")
      .run(sessionId, this.nowIso());
  }

  updateLastHookTime(sessionId: string): void {
    if (!sessionId) throw new ServiceError("invalid_session", "sessionId is required");
    const now = this.nowIso();
    this.db
      .query(
        "INSERT INTO sessions (sessionId, lastHookTime) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET lastHookTime = excluded.lastHookTime",
      )
      .run(sessionId, now);
  }

  promotePendingWatermark(sessionId: string): void {
    this.db
      .query(
        "UPDATE sessions SET lastUpdated = pendingLastUpdated, pendingLastUpdated = NULL WHERE sessionId = ? AND pendingLastUpdated IS NOT NULL",
      )
      .run(sessionId);
  }

  setSessionPid(sessionId: string, pid: number): void {
    this.ensureSessionRow(sessionId);
    const existing = this.db
      .query<{ pid: number | null }, [string]>("SELECT pid FROM sessions WHERE sessionId = ?")
      .get(sessionId);
    if (existing?.pid === pid) {
      // Idempotent: the loop already stored this pid via recordSpawnSuccess,
      // and this is the child's own SessionStart hook echoing back. Preserve
      // pendingLastUpdated so the same-turn claim sees an empty delta
      // (per DESIGN.md §Components/Agent Loop interaction).
      return;
    }
    this.db
      .query(
        "UPDATE sessions SET pid = ?, pendingLastUpdated = NULL, pendingWarning = 0, spawnFailures = 0, spawnBackoffUntil = NULL WHERE sessionId = ?",
      )
      .run(pid, sessionId);
  }

  clearSessionPid(sessionId: string): void {
    this.db.query("UPDATE sessions SET pid = NULL WHERE sessionId = ?").run(sessionId);
  }

  subscribe(sessionId: string, pattern: string): void {
    if (!sessionId) throw new ServiceError("invalid_session", "sessionId is required");
    if (!isValidPattern(pattern)) {
      throw new ServiceError("invalid_pattern", `invalid pattern ${JSON.stringify(pattern)}`);
    }
    this.ensureSessionRow(sessionId);
    this.db
      .query("INSERT OR IGNORE INTO subscriptions (sessionId, pattern) VALUES (?, ?)")
      .run(sessionId, pattern);
    this.markDirty();
  }

  unsubscribe(sessionId: string, pattern: string): void {
    this.db
      .query("DELETE FROM subscriptions WHERE sessionId = ? AND pattern = ?")
      .run(sessionId, pattern);
    this.markDirty();
  }

  listSubscriptions(sessionId: string): string[] {
    const rows = this.db
      .query<{ pattern: string }, [string]>(
        "SELECT pattern FROM subscriptions WHERE sessionId = ? ORDER BY pattern ASC",
      )
      .all(sessionId);
    return rows.map((r) => r.pattern);
  }

  tag(sessionId: string, tag: string): void {
    if (!sessionId) throw new ServiceError("invalid_session", "sessionId is required");
    if (typeof tag !== "string" || tag.length === 0) {
      throw new ServiceError("invalid_tag", "tag must be a non-empty string");
    }
    this.ensureSessionRow(sessionId);
    this.db.query("INSERT OR IGNORE INTO tags (sessionId, tag) VALUES (?, ?)").run(sessionId, tag);
    this.markDirty();
  }

  untag(sessionId: string, tag: string): void {
    this.db.query("DELETE FROM tags WHERE sessionId = ? AND tag = ?").run(sessionId, tag);
    this.markDirty();
  }

  listTags(sessionId: string): string[] {
    const rows = this.db
      .query<{ tag: string }, [string]>("SELECT tag FROM tags WHERE sessionId = ? ORDER BY tag ASC")
      .all(sessionId);
    return rows.map((r) => r.tag);
  }

  private resolvePatterns(sessionId: string): string[] {
    const direct = this.listSubscriptions(sessionId);
    const tagRows = this.db
      .query<{ tag: string }, [string]>("SELECT tag FROM tags WHERE sessionId = ?")
      .all(sessionId);
    const sessionTags = new Set(tagRows.map((r) => r.tag));
    const fromConfig = this.config.subscriptions
      .filter((s) => sessionTags.has(s.tag))
      .map((s) => s.pattern);
    return Array.from(new Set([...direct, ...fromConfig]));
  }

  private sessionWatermark(sessionId: string): string | null {
    const row = this.db
      .query<{ lastUpdated: string | null; pendingLastUpdated: string | null }, [string]>(
        "SELECT lastUpdated, pendingLastUpdated FROM sessions WHERE sessionId = ?",
      )
      .get(sessionId);
    if (!row) return null;
    const a = row.lastUpdated;
    const b = row.pendingLastUpdated;
    if (a && b) return a > b ? a : b;
    return a ?? b ?? null;
  }

  getPendingEvents(sessionId: string, since?: string): StoredEvent[] {
    const patterns = this.resolvePatterns(sessionId);
    if (patterns.length === 0) return [];
    const effectiveSince = since ?? this.sessionWatermark(sessionId);
    const params: string[] = [];
    let where = "";
    if (effectiveSince) {
      where = "WHERE publishedAt > ?";
      params.push(effectiveSince);
    }
    const selfSource = `urn:unguibus:hook:${sessionId}`;
    const rows = this.db
      .query<EventRow, string[]>(`SELECT * FROM events ${where} ORDER BY publishedAt ASC, id ASC`)
      .all(...params);
    return rows
      .filter((r) => r.source !== selfSource)
      .filter((r) => patterns.some((p) => matchesPattern(p, r.type)))
      .map(rowToStored);
  }

  claimPendingEvents(sessionId: string): StoredEvent[] {
    const all = this.getPendingEvents(sessionId);
    if (all.length === 0) {
      this.db.query("UPDATE sessions SET pendingWarning = 0 WHERE sessionId = ?").run(sessionId);
      return [];
    }
    const cap = this.config.server.maxEventsPerDelivery;
    const capped = all.length > cap ? all.slice(0, cap) : all;
    let advanceTo: string;
    if (all.length > cap) {
      const next = all[cap];
      if (!next) {
        advanceTo = capped[capped.length - 1]?.publishedAt ?? this.nowIso();
      } else {
        const d = new Date(next.publishedAt).getTime() - 1;
        advanceTo = new Date(d).toISOString();
      }
    } else {
      advanceTo = capped[capped.length - 1]?.publishedAt ?? this.nowIso();
    }
    this.db
      .query("UPDATE sessions SET pendingLastUpdated = ?, pendingWarning = 0 WHERE sessionId = ?")
      .run(advanceTo, sessionId);
    return capped;
  }

  listConnectorStatus(): ConnectorStatus[] {
    interface StateRow {
      name: string;
      lastRunTime: string | null;
      lastExitCode: number | null;
      consecutiveFailures: number;
    }
    const rows = this.db
      .query<StateRow, []>(
        "SELECT name, lastRunTime, lastExitCode, consecutiveFailures FROM connector_state",
      )
      .all();
    const byName = new Map<string, StateRow>();
    for (const r of rows) byName.set(r.name, r);
    return this.config.connectors.map((c) => {
      const state = byName.get(c.name);
      return {
        name: c.name,
        type: c.type,
        source: c.source,
        intervalMs: c.intervalMs,
        timeoutMs: c.timeoutMs,
        lastRunTime: state?.lastRunTime ?? null,
        lastExitCode: state?.lastExitCode ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        backoffUntil: null,
      };
    });
  }

  listAllSubscriptions(): SubscriptionRollup[] {
    interface SessionStateRow {
      sessionId: string;
      lastUpdated: string | null;
      pendingLastUpdated: string | null;
      lastHookTime: string | null;
    }
    const pickWatermark = (a: string | null, b: string | null): string | null => {
      if (a && b) return a > b ? a : b;
      return a ?? b ?? null;
    };

    const directRows = this.db
      .query<
        {
          pattern: string;
          sessionId: string;
          lastUpdated: string | null;
          pendingLastUpdated: string | null;
          lastHookTime: string | null;
        },
        []
      >(
        `SELECT subs.pattern, subs.sessionId, sess.lastUpdated, sess.pendingLastUpdated, sess.lastHookTime
         FROM subscriptions subs
         LEFT JOIN sessions sess ON sess.sessionId = subs.sessionId
         ORDER BY subs.pattern ASC, subs.sessionId ASC`,
      )
      .all();
    const directByPattern = new Map<string, SubscriptionSessionInfo[]>();
    for (const r of directRows) {
      const info: SubscriptionSessionInfo = {
        sessionId: r.sessionId,
        watermark: pickWatermark(r.lastUpdated, r.pendingLastUpdated),
        lastHookTime: r.lastHookTime,
      };
      const arr = directByPattern.get(r.pattern) ?? [];
      arr.push(info);
      directByPattern.set(r.pattern, arr);
    }

    const rollups: SubscriptionRollup[] = [];
    for (const [pattern, sessions] of directByPattern) {
      rollups.push({ pattern, origin: "direct", tag: null, sessions });
    }

    for (const sub of this.config.subscriptions) {
      const rows = this.db
        .query<SessionStateRow, [string]>(
          `SELECT t.sessionId, sess.lastUpdated, sess.pendingLastUpdated, sess.lastHookTime
           FROM tags t
           LEFT JOIN sessions sess ON sess.sessionId = t.sessionId
           WHERE t.tag = ?
           ORDER BY t.sessionId ASC`,
        )
        .all(sub.tag);
      const sessions = rows.map((r) => ({
        sessionId: r.sessionId,
        watermark: pickWatermark(r.lastUpdated, r.pendingLastUpdated),
        lastHookTime: r.lastHookTime,
      }));
      rollups.push({ pattern: sub.pattern, origin: "config", tag: sub.tag, sessions });
    }

    rollups.sort((a, b) => {
      if (a.pattern !== b.pattern) return a.pattern < b.pattern ? -1 : 1;
      return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
    });
    return rollups;
  }

  listQueues(): QueueStatus[] {
    interface SessionRow {
      sessionId: string;
    }
    const sessionIds = new Set<string>();
    for (const r of this.db.query<SessionRow, []>("SELECT sessionId FROM subscriptions").all()) {
      sessionIds.add(r.sessionId);
    }
    if (this.config.subscriptions.length > 0) {
      for (const r of this.db.query<SessionRow, []>("SELECT sessionId FROM tags").all()) {
        sessionIds.add(r.sessionId);
      }
    }
    const queues: QueueStatus[] = [];
    for (const sessionId of sessionIds) {
      const patterns = this.resolvePatterns(sessionId);
      if (patterns.length === 0) continue;
      const since = this.sessionWatermark(sessionId);
      const selfSource = `urn:unguibus:hook:${sessionId}`;
      interface CandidateRow {
        type: string;
        source: string;
        publishedAt: string;
      }
      const params: string[] = [];
      let where = "source != ?";
      params.push(selfSource);
      if (since) {
        where += " AND publishedAt > ?";
        params.push(since);
      }
      const rows = this.db
        .query<CandidateRow, string[]>(
          `SELECT type, source, publishedAt FROM events WHERE ${where} ORDER BY publishedAt ASC`,
        )
        .all(...params);
      for (const pattern of patterns) {
        let count = 0;
        let oldest: string | null = null;
        for (const r of rows) {
          if (!matchesPattern(pattern, r.type)) continue;
          count += 1;
          if (oldest === null || r.publishedAt < oldest) oldest = r.publishedAt;
        }
        queues.push({ sessionId, pattern, pendingCount: count, oldestPendingAt: oldest });
      }
    }
    queues.sort((a, b) => {
      if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
      return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
    });
    return queues;
  }

  getAgentStatus(): AgentStatus {
    if (this.agentStatusProvider) return this.agentStatusProvider();
    return {
      state: "idle",
      currentSessionId: null,
      dirty: false,
      lastLoopTime: null,
      recentCadenceMs: 0,
    };
  }

  listLoopCandidates(): LoopCandidate[] {
    interface Row {
      sessionId: string;
      pid: number | null;
      lastUpdated: string | null;
      spawnBackoffUntil: string | null;
    }
    const rows = this.db
      .query<Row, []>(
        `SELECT DISTINCT s.sessionId, s.pid, s.lastUpdated, s.spawnBackoffUntil
         FROM sessions s
         WHERE s.sessionId IN (
           SELECT sessionId FROM subscriptions
           UNION
           SELECT sessionId FROM tags
         )
         ORDER BY s.sessionId ASC`,
      )
      .all();
    return rows.map((r) => ({
      sessionId: r.sessionId,
      pid: r.pid,
      lastUpdated: r.lastUpdated,
      spawnBackoffUntil: r.spawnBackoffUntil,
    }));
  }

  getLoopPendingEvents(sessionId: string): StoredEvent[] {
    const patterns = this.resolvePatterns(sessionId);
    if (patterns.length === 0) return [];
    const row = this.db
      .query<{ lastUpdated: string | null }, [string]>(
        "SELECT lastUpdated FROM sessions WHERE sessionId = ?",
      )
      .get(sessionId);
    const since = row?.lastUpdated ?? null;
    const selfSource = `urn:unguibus:hook:${sessionId}`;
    const params: string[] = [selfSource];
    let where = "source != ?";
    if (since !== null) {
      where += " AND publishedAt > ?";
      params.push(since);
    }
    const rows = this.db
      .query<EventRow, string[]>(
        `SELECT * FROM events WHERE ${where} ORDER BY publishedAt ASC, id ASC`,
      )
      .all(...params);
    return rows.filter((r) => patterns.some((p) => matchesPattern(p, r.type))).map(rowToStored);
  }

  setPendingWatermark(sessionId: string, isoTime: string): void {
    this.ensureSessionRow(sessionId);
    this.db
      .query("UPDATE sessions SET pendingLastUpdated = ? WHERE sessionId = ?")
      .run(isoTime, sessionId);
  }

  recordSpawnSuccess(sessionId: string, pid: number): void {
    this.ensureSessionRow(sessionId);
    this.db
      .query(
        "UPDATE sessions SET pid = ?, spawnFailures = 0, spawnBackoffUntil = NULL WHERE sessionId = ?",
      )
      .run(pid, sessionId);
  }

  recordSpawnFailure(sessionId: string, backoffCapMs: number): SpawnFailureResult {
    this.ensureSessionRow(sessionId);
    interface Row {
      spawnFailures: number;
    }
    const row = this.db
      .query<Row, [string]>("SELECT spawnFailures FROM sessions WHERE sessionId = ?")
      .get(sessionId);
    const nextFailures = (row?.spawnFailures ?? 0) + 1;
    const backoffMs = Math.min(2 ** nextFailures * 1000, backoffCapMs);
    const backoffUntil = new Date(this.nowFn() + backoffMs).toISOString();
    this.db
      .query(
        "UPDATE sessions SET pendingLastUpdated = NULL, spawnFailures = ?, spawnBackoffUntil = ? WHERE sessionId = ?",
      )
      .run(nextFailures, backoffUntil, sessionId);
    return { spawnFailures: nextFailures, spawnBackoffUntil: backoffUntil };
  }

  listLivePidSessions(): LivePidSession[] {
    interface Row {
      sessionId: string;
      pid: number;
      lastHookTime: string | null;
      pendingWarning: number;
    }
    const rows = this.db
      .query<Row, []>(
        "SELECT sessionId, pid, lastHookTime, pendingWarning FROM sessions WHERE pid IS NOT NULL",
      )
      .all();
    return rows.map((r) => ({
      sessionId: r.sessionId,
      pid: r.pid,
      lastHookTime: r.lastHookTime,
      pendingWarning: r.pendingWarning !== 0,
    }));
  }

  markPendingWarning(sessionId: string): void {
    this.db.query("UPDATE sessions SET pendingWarning = 1 WHERE sessionId = ?").run(sessionId);
  }

  cleanupKilledSession(sessionId: string): void {
    this.db
      .query(
        "UPDATE sessions SET pid = NULL, pendingLastUpdated = NULL, pendingWarning = 0 WHERE sessionId = ?",
      )
      .run(sessionId);
  }

  asCloudEvent(stored: StoredEvent): CloudEvent {
    return {
      specversion: stored.specversion,
      id: stored.id,
      source: stored.source,
      type: stored.type,
      time: stored.time,
      datacontenttype: stored.datacontenttype,
      data: stored.data,
    };
  }
}
