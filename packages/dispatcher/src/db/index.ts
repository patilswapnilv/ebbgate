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
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, findMigrationsDir());
  return db;
}

function migrate(db: Db, dir: string): void {
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
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    })();
  }
}
