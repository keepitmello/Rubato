// Cloudflare D1's statement API over node:sqlite, so the relay's real SQL and the real migration run in tests.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(path.join(migrations, name), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    async first(column) {
      const row = db.prepare(sql).get(...args);
      return row ? (column ? row[column] : { ...row }) : null;
    },
    async all() { return { results: db.prepare(sql).all(...args).map(row => ({ ...row })) }; },
    async run() { return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
    runNow: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: sql => statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = statements.map(item => item.runNow()); db.exec('COMMIT'); return out; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    /** Every row of every table, for checking what the relay keeps. */
    dump: () => Object.fromEntries(['devices', 'grants', 'provider_tokens'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])),
  };
}
