import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type OpenPulseDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function resolveDbPath(): string {
  return process.env.OPENPULSE_DB ?? path.join(process.cwd(), 'data', 'openpulse.db');
}

export function resolveMigrationsFolder(): string {
  return process.env.OPENPULSE_MIGRATIONS ?? path.join(process.cwd(), 'drizzle');
}

export interface OpenOptions {
  migrate?: boolean;
  migrationsFolder?: string;
}

/**
 * Open (and migrate) the SQLite database. WAL mode lets the daemon write while
 * the dashboard reads; busy_timeout absorbs short lock contention between them.
 */
export function openDatabase(file: string = resolveDbPath(), options: OpenOptions = {}): OpenPulseDb {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema }) as OpenPulseDb;
  if (options.migrate !== false) {
    migrate(db, { migrationsFolder: options.migrationsFolder ?? resolveMigrationsFolder() });
  }
  return db;
}

const globalForDb = globalThis as unknown as { __openpulseDb?: OpenPulseDb };

/** Process-wide connection (survives Next.js hot reloads in development). */
export function getDb(): OpenPulseDb {
  globalForDb.__openpulseDb ??= openDatabase();
  return globalForDb.__openpulseDb;
}

export function closeDb(): void {
  globalForDb.__openpulseDb?.$client.close();
  globalForDb.__openpulseDb = undefined;
}
