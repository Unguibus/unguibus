import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(dbFile: string): Database {
  if (dbFile !== ":memory:") {
    mkdirSync(dirname(dbFile), { recursive: true });
  }
  const db = new Database(dbFile, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  return db;
}

export function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      time TEXT NOT NULL,
      publishedAt TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type_publishedAt
      ON events(type, publishedAt);
    CREATE INDEX IF NOT EXISTS idx_events_publishedAt
      ON events(publishedAt);

    CREATE TABLE IF NOT EXISTS sessions (
      sessionId TEXT PRIMARY KEY,
      lastUpdated TEXT,
      pendingLastUpdated TEXT,
      pid INTEGER,
      lastHookTime TEXT,
      pendingWarning INTEGER NOT NULL DEFAULT 0,
      spawnFailures INTEGER NOT NULL DEFAULT 0,
      spawnBackoffUntil TEXT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      sessionId TEXT NOT NULL,
      pattern TEXT NOT NULL,
      UNIQUE(sessionId, pattern)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_session
      ON subscriptions(sessionId);

    CREATE TABLE IF NOT EXISTS tags (
      sessionId TEXT NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(sessionId, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_session ON tags(sessionId);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

    CREATE TABLE IF NOT EXISTS connector_state (
      name TEXT PRIMARY KEY,
      lastHash TEXT,
      lastRunTime TEXT,
      consecutiveFailures INTEGER NOT NULL DEFAULT 0
    );
  `);
}
