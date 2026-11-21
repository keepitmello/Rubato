import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Every Rubato server statement must use an index on the large tables by itself. T3 v0.1.11
// clears the planner statistics at startup (persistence/Sqlite.ts), so a query that leaned on
// them — threadStreamGaps without aggregate_kind — scanned the whole event log for ~100 s while
// every other statement waited for the one connection. RUBATO_SQL_PLAN_DB names a database with
// the v0.1.11 schema (an isolated server's statev2.sqlite); it is opened read-only and only
// EXPLAINed, with its statistics ignored.
const db = process.env.RUBATO_SQL_PLAN_DB;
// Command receipts are left out: RubatoStateRetention keeps them to three days (7.8k rows on
// the user's database), and its own prune is the statement that scans them.
const LARGE = ['orchestration_events', 'orchestration_v2_projection_messages',
  'orchestration_v2_projection_items', 'orchestration_v2_projection_runs'];
const serverDir = fileURLToPath(new URL('../overlay/apps/server/src/', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? files(full) : /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
});

test('Rubato server SQL uses an index on the large tables without planner statistics', { skip: !db }, () => {
  const conn = new DatabaseSync(`file:${db}?mode=ro`, { readOnly: true });
  // T3 v0.1.11 runs without statistics; a database that still has them would hide a scan.
  const stats = conn.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get().n > 0
    ? conn.prepare('SELECT count(*) AS n FROM sqlite_stat1').get().n : 0;
  assert.equal(stats, 0, 'the plan database still has planner statistics');
  const scans = [];
  let checked = 0;
  for (const file of files(serverDir)) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/sql(?:<[\s\S]*?>)?`([\s\S]*?)`/g)) {
      // Nested fragments (sql`` and sql.in) become an empty string and a one-value list.
      const text = match[1].replace(/\$\{sql\.in\([^)]*\)\}/g, '(?)').replace(/\$\{[^}]*\}/g, '?').trim();
      if (!/^(SELECT|WITH|UPDATE|DELETE)/i.test(text)) continue;
      let plan;
      try { plan = conn.prepare(`EXPLAIN QUERY PLAN ${text}`).all().map((row) => row.detail); } catch { continue; }
      checked += 1;
      for (const detail of plan) {
        const scan = /^SCAN (\w+)/.exec(detail);
        if (scan && LARGE.includes(scan[1]) && !/USING (COVERING )?INDEX/.test(detail))
          scans.push(`${path.basename(file)}:${src.slice(0, match.index).split('\n').length} ${detail}`);
      }
    }
  }
  conn.close();
  assert.ok(checked > 20, `only ${checked} statements prepared`);
  assert.deepEqual(scans, []);
});
