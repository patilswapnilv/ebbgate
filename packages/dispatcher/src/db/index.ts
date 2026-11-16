import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Open (or create) the SQLite database and apply pending SQL migrations.
 * Pass `:memory:` for tests.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
  );

  let files: string[] = [];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    // When running from a bundled dist without copied SQL, fall back to inline init.
    if (!applied.has("001_init.sql")) {
      applyInlineInit(db);
    }
    return;
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    });
    run();
  }
}

/** Bundled fallback so `tsup` builds still migrate without shipping .sql files. */
function applyInlineInit(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('available', 'busy', 'offline')),
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'busy', 'available')),
  last_seen_at TEXT,
  report_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  issue_id TEXT,
  agent_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('local', 'cloud')),
  node_id TEXT,
  priority TEXT CHECK (priority IN ('normal', 'low')),
  status TEXT NOT NULL CHECK (status IN ('running', 'interrupted', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deferred (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  issue_id TEXT,
  agent_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'waking', 'done', 'expired')),
  wake_idempotency_key TEXT
);

CREATE INDEX IF NOT EXISTS deferred_pending_created ON deferred (status, created_at);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  issue_id TEXT,
  tier TEXT NOT NULL,
  action TEXT NOT NULL,
  node_id TEXT,
  reason TEXT NOT NULL,
  rule_ref TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
`);
  db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
    "001_init.sql",
    new Date().toISOString(),
  );
}
