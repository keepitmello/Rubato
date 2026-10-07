import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { t3Modules } from './t3-source.mjs';

// Retention of the GUI server's state DB (overlay/apps/server/src/RubatoStateRetention.ts),
// run against T3's own migrations and, for the work log, T3's own snapshot projection:
// a pruned work log must give the same thread snapshot as the full one.
const source = process.env.T3_SOURCE;
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

async function load() {
  const modules = t3Modules(source);
  const [Effect, Layer, SqlClient] = await Promise.all(['Effect', 'Layer', 'unstable/sql/SqlClient'].map((name) => modules.effect(name)));
  const NodeServices = await import(pathToFileURL(createRequire(path.join(source, 'apps/server/package.json')).resolve('@effect/platform-node/NodeServices')));
  const Sqlite = await modules.source('apps/server/src/persistence/Layers/Sqlite.ts');
  const retention = await modules.source('apps/server/src/RubatoStateRetention.ts');
  const { ORCHESTRATION_PROJECTOR_NAMES } = await modules.source('apps/server/src/orchestration/Layers/ProjectionPipeline.ts');
  const { projectThreadDetailSnapshot } = await modules.source('apps/server/src/orchestration/ActivityPayloadProjection.ts');
  const persistence = (file) => Sqlite.makeSqlitePersistenceLive(file).pipe(Layer.provide(NodeServices.layer));
  const run = (file, effect) => Effect.runPromise(effect.pipe(Effect.provide(persistence(file))));
  return { Effect, Layer, SqlClient, retention, persistence, run, projectThreadDetailSnapshot,
    projectors: [...Object.values(ORCHESTRATION_PROJECTOR_NAMES), retention.ATTACHMENT_CLEANUP_PROJECTOR] };
}

async function database(t, m) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rb-state-retention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.sqlite');
  await m.run(file, m.Effect.void); // T3's migrations create the schema.
  const db = new DatabaseSync(file);
  t.after(() => db.isOpen && db.close());
  return { file, db };
}

function cursors(db, projectors, sequence, overrides = {}) {
  const insert = db.prepare('INSERT OR REPLACE INTO projection_state (projector, last_applied_sequence, updated_at) VALUES (?, ?, ?)');
  for (const name of projectors) if (overrides[name] !== null) insert.run(name, overrides[name] ?? sequence, ago(0));
}

function event(db, sequence, type, occurredAt) {
  db.prepare(`INSERT INTO orchestration_events (sequence, event_id, aggregate_kind, stream_id, stream_version,
    event_type, occurred_at, actor_kind, payload_json, metadata_json) VALUES (?, ?, 'thread', 't1', ?, ?, ?, 'server', '{}', '{}')`)
    .run(sequence, `e${sequence}`, sequence, type, occurredAt);
}

function thread(db, id, deletedAt = null) {
  db.prepare(`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
    VALUES (?, 'p', 'title', ?, ?, ?)`).run(id, ago(30), ago(30), deletedAt);
}

function activity(db, row) {
  db.prepare(`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
    VALUES (?, ?, ?, 'tool', ?, 'summary', ?, ?, ?)`)
    .run(row.id, row.thread ?? 't1', row.turn ?? null, row.kind, JSON.stringify(row.payload ?? {}), row.at, row.sequence ?? null);
}

const ids = (db, sql) => db.prepare(sql).all().map((row) => Object.values(row)[0]);

// The thread detail snapshot the server sends, built from the stored rows.
function snapshot(m, db, threadId = 't1') {
  const activities = db.prepare(`SELECT * FROM projection_thread_activities WHERE thread_id = ?
    ORDER BY sequence ASC, created_at ASC, activity_id ASC`).all(threadId).map((row) => ({
    id: row.activity_id, tone: row.tone, kind: row.kind, summary: row.summary, payload: JSON.parse(row.payload_json),
    turnId: row.turn_id, ...(row.sequence === null ? {} : { sequence: row.sequence }), createdAt: row.created_at,
  }));
  return m.projectThreadDetailSnapshot({ snapshotSequence: 0, thread: { id: threadId, messages: [], activities } }).thread.activities;
}

test('only activity events every projector has applied and older than 3 days are deleted', { skip: !source }, async (t) => {
  const m = await load();
  const { file, db } = await database(t, m);
  event(db, 1, 'thread.activity-appended', ago(5));
  event(db, 2, 'thread.message-sent', ago(5));
  event(db, 3, 'thread.session-set', ago(5));
  event(db, 4, 'thread.activity-appended', ago(1));
  event(db, 5, 'thread.activity-appended', ago(5)); // old, but the cleanup cursor has not reached it
  cursors(db, m.projectors, 6, { [m.retention.ATTACHMENT_CLEANUP_PROJECTOR]: 4 });
  assert.equal(await m.run(file, m.retention.pruneActivityEvents(Date.now())), 1);
  assert.deepEqual(ids(db, 'SELECT sequence FROM orchestration_events ORDER BY sequence'), [2, 3, 4, 5]);
});

test('no event is deleted while a projector has no cursor yet', { skip: !source }, async (t) => {
  const m = await load();
  const { file, db } = await database(t, m);
  event(db, 1, 'thread.activity-appended', ago(5));
  // A projector T3 adds in a later version starts from 0 and replays every event.
  cursors(db, m.projectors, 9, { [m.projectors[0]]: null });
  assert.equal(await m.run(file, m.retention.pruneActivityEvents(Date.now())), 0);
  assert.deepEqual(ids(db, 'SELECT sequence FROM orchestration_events'), [1]);
});

test('command receipts and deleted threads\' work logs age out after 3 days', { skip: !source }, async (t) => {
  const m = await load();
  const { file, db } = await database(t, m);
  const receipt = db.prepare(`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
    VALUES (?, 'thread', 't1', ?, 1, 'accepted')`);
  receipt.run('old', ago(4));
  receipt.run('new', ago(1));
  thread(db, 'gone', ago(4));
  thread(db, 'just-gone', ago(1));
  thread(db, 'live');
  for (const id of ['gone', 'just-gone', 'live']) activity(db, { id: `a-${id}`, thread: id, kind: 'task.started', at: ago(30) });
  assert.equal(await m.run(file, m.retention.pruneReceipts(Date.now())), 1);
  assert.equal(await m.run(file, m.retention.pruneDeletedThreadActivities(Date.now())), 1);
  assert.deepEqual(ids(db, 'SELECT command_id FROM orchestration_command_receipts'), ['new']);
  assert.deepEqual(ids(db, 'SELECT activity_id FROM projection_thread_activities ORDER BY activity_id'), ['a-just-gone', 'a-live']);
});

test('old tool output bodies go, and the thread snapshot stays the same', { skip: !source }, async (t) => {
  const m = await load();
  const { file, db } = await database(t, m);
  thread(db, 't1');
  const body = { itemType: 'dynamic_tool_call', toolCallId: 'call-1', status: 'completed', title: 'bash',
    data: { content: [{ type: 'text', text: 'line\n'.repeat(1000) }], details: { status: 'ok' },
      rubatoActivity: { kind: 'command', target: 'npm test' }, toolCallId: 'call-1' } };
  activity(db, { id: 'old', kind: 'tool.completed', payload: body, at: ago(20) });
  activity(db, { id: 'recent', kind: 'tool.completed', payload: { ...body, toolCallId: 'call-2' }, at: ago(2) });
  // Entries of type "content" reach the client as a one-line summary, so they stay.
  const acp = { ...body, toolCallId: 'call-3', data: { content: [{ type: 'content', content: { type: 'text', text: 'shown' } }] } };
  activity(db, { id: 'acp', kind: 'tool.completed', payload: acp, at: ago(20) });
  activity(db, { id: 'other-kind', kind: 'task.completed', payload: { data: { content: 'kept' } }, at: ago(20) });
  const before = snapshot(m, db);
  assert.equal(await m.run(file, m.retention.trimOldToolOutputs(Date.now())), 1);
  const payload = (id) => JSON.parse(db.prepare('SELECT payload_json FROM projection_thread_activities WHERE activity_id = ?').get(id).payload_json);
  const { content, ...rest } = body.data;
  assert.deepEqual(payload('old'), { ...body, data: rest });
  assert.ok(payload('recent').data.content);
  assert.deepEqual(payload('acp'), acp);
  assert.equal(payload('other-kind').data.content, 'kept');
  assert.deepEqual(snapshot(m, db), before);
  assert.equal(await m.run(file, m.retention.trimOldToolOutputs(Date.now())), 0, 'a second pass finds nothing');
});

test('old superseded tool updates and context-window rows go, and the thread snapshot stays the same', { skip: !source }, async (t) => {
  const m = await load();
  const { file, db } = await database(t, m);
  thread(db, 't1');
  const tool = (id) => ({ itemType: 'command_execution', toolCallId: id, title: 'bash', status: 'inProgress' });
  const at = (day, minute) => new Date(Date.now() - day * DAY + minute * 60_000).toISOString();
  // Turn A: two updates, then the completion. Both updates go.
  activity(db, { id: 'u1', turn: 'A', kind: 'tool.updated', payload: tool('c1'), at: at(20, 0) });
  activity(db, { id: 'u2', turn: 'A', kind: 'tool.updated', payload: tool('c1'), at: at(20, 1) });
  activity(db, { id: 'done', turn: 'A', kind: 'tool.completed', payload: { ...tool('c1'), status: 'completed' }, at: at(20, 2) });
  // An update after the completion belongs to a later call with the same id.
  activity(db, { id: 'u-after', turn: 'A', kind: 'tool.updated', payload: tool('c1'), at: at(20, 3) });
  // The completion in another turn does not count: a revert can drop that turn.
  activity(db, { id: 'u-other-turn', turn: 'B', kind: 'tool.updated', payload: tool('c1'), at: at(20, 0) });
  // No completion yet, and a recent superseded update: both stay.
  activity(db, { id: 'u-open', turn: 'A', kind: 'tool.updated', payload: tool('c9'), at: at(20, 4) });
  activity(db, { id: 'u-recent', turn: 'C', kind: 'tool.updated', payload: tool('c5'), at: at(1, 0) });
  activity(db, { id: 'done-recent', turn: 'C', kind: 'tool.completed', payload: tool('c5'), at: at(1, 1) });
  // Context window: the newest two per turn stay, unreadable rows stay.
  for (let minute = 10; minute < 15; minute += 1)
    activity(db, { id: `cw${minute}`, turn: 'A', kind: 'context-window.updated', payload: { usedTokens: minute * 100 }, at: at(20, minute) });
  activity(db, { id: 'cw-bad', turn: 'A', kind: 'context-window.updated', payload: { usedTokens: 'n/a' }, at: at(20, 9) });
  activity(db, { id: 'cw-b', turn: 'B', kind: 'context-window.updated', payload: { usedTokens: 5 }, at: at(20, 9) });
  const before = snapshot(m, db);
  const pruned = await m.run(file, m.retention.pruneOldIntermediates(Date.now()));
  assert.deepEqual(pruned, { supersededToolUpdates: 2, contextWindowRows: 3 });
  assert.deepEqual(ids(db, 'SELECT activity_id FROM projection_thread_activities ORDER BY activity_id'),
    ['cw-b', 'cw-bad', 'cw13', 'cw14', 'done', 'done-recent', 'u-after', 'u-open', 'u-other-turn', 'u-recent']);
  assert.deepEqual(snapshot(m, db), before);
});

test('startup compacts once without waiting for a large retention history; later passes reclaim pages', { skip: !source }, async (t) => {
  const m = await load();
  const { file, db } = await database(t, m);
  // Sparse, high sequences reproduce a pass that exceeds desktop readiness.
  cursors(db, m.projectors, 10_000_000);
  for (let sequence = 1; sequence <= 50; sequence += 1) event(db, sequence, 'thread.activity-appended', ago(5));
  db.close();
  // First start must become ready even while the retention pass is unfinished.
  const first = await m.run(file, m.Effect.scoped(m.Effect.gen(function* () {
    yield* m.Layer.build(m.retention.rubatoStateRetentionLayer);
    return yield* m.retention.autoVacuumMode;
  })));
  assert.equal(first, 2);
  const reopened = new DatabaseSync(file);
  t.after(() => reopened.isOpen && reopened.close());
  assert.ok(reopened.prepare('SELECT COUNT(*) AS n FROM orchestration_events').get().n > 0);
  cursors(reopened, m.projectors, 100);
  // Later starts run the pass in the background, and it gives freed pages back.
  const receipt = reopened.prepare(`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
    VALUES (?, 'thread', 't1', ?, 1, 'rejected')`);
  for (let index = 0; index < 3000; index += 1) receipt.run(`old-${index}-${'x'.repeat(200)}`, ago(4));
  reopened.close();
  const second = await m.run(file, m.Effect.scoped(m.Effect.gen(function* () {
    yield* m.Layer.build(m.retention.rubatoStateRetentionLayer);
    const sql = yield* m.SqlClient.SqlClient;
    for (let tries = 0; tries < 200; tries += 1) {
      const [{ n }] = yield* sql`SELECT COUNT(*) AS n FROM orchestration_command_receipts`;
      const [{ freelist_count }] = yield* sql`PRAGMA freelist_count`;
      if (n === 0 && freelist_count === 0) return { n, freelist_count };
      yield* m.Effect.sleep(20);
    }
    return 'the background pass did not finish';
  })));
  assert.deepEqual(second, { n: 0, freelist_count: 0 });
});

test('the cleanup cursor name matches the projection pipeline', { skip: !source }, async () => {
  const m = await load();
  const pipeline = await readFile(path.join(source, 'apps/server/src/orchestration/Layers/ProjectionPipeline.ts'), 'utf8');
  assert.match(pipeline, new RegExp(`const cleanupProjector = "${m.retention.ATTACHMENT_CLEANUP_PROJECTOR}"`));
});

test('the server, and only the server, opens the state DB through the retention layer', { skip: !source }, async () => {
  const server = await readFile(path.join(source, 'apps/server/src/server.ts'), 'utf8');
  assert.match(server, /import \{ rubatoStatePersistenceLayer as SqlitePersistenceLayerLive \} from "\.\/RubatoStateRetention\.ts";/);
  const cli = await readFile(path.join(source, 'apps/server/src/cli/project.ts'), 'utf8');
  assert.doesNotMatch(cli, /RubatoStateRetention/);
  const tsconfig = JSON.parse(await readFile(path.join(source, 'tsconfig.base.json'), 'utf8'));
  assert.equal(tsconfig.compilerOptions.checkers, 1);
});
