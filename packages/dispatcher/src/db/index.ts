import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the SQL migrations live:
 * - from source (`src/db/index.ts`): `src/db/migrations`
 * - from the tsup bundle (`dist/index.js`): `dist/migrations` (copied by the build script)
 */
const MIGRATION_DIR_CANDIDATES = [join(HERE, "migrations"), join(HERE, "db", "migrations")];

export function findMigrationsDir(candidates = MIGRATION_DIR_CANDIDATES): string {
  for (const dir of candidates) {
    if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".sql"))) return dir;
  }
  throw new Error(
    `ebbgate: SQL migrations not found (looked in ${candidates.join(", ")}). ` +
      "Rebuild the dispatcher so dist/migrations is populated.",
  );
}

/**
 * Open (or create) the SQLite database and apply pending SQL migrations.
 * Pass `:memory:` for tests.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  configureDb(db);
  migrate(db, findMigrationsDir());
  return db;
}

/** How long a writer waits for another connection's lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Durability settings, applied to every connection:
 * - WAL: readers never block the writer, and a crash mid-write cannot corrupt the file.
 * - synchronous = FULL: a committed transaction (for example a deferral acknowledged
 *   to Paperclip) survives power loss, not just a process crash.
 * - busy_timeout: a second connection (another drainer, `ebbgate status`) waits for
 *   the lock instead of failing immediately.
 */
export function configureDb(db: Db): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("foreign_keys = ON");
}

export function migrate(db: Db, dir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    // IMMEDIATE takes the write lock up front, and the re-check inside it means two
    // processes opening the same file at once cannot both apply a migration.
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(file)) return;
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    }).immediate();
  }
}
