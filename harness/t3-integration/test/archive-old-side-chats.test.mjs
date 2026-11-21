import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { OLD_SIDE_CHAT_PREFIX, listOldSideChats, planArchive } from '../archive-old-side-chats.mjs';

// A fixture state database with the columns the cutover step reads; never the live one.
function fixture(rows) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'old-side-chats-'));
  const file = path.join(dir, 'statev2.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`create table orchestration_v2_projection_threads (
    thread_id text primary key, project_id text not null, title text not null,
    created_at text not null, archived_at text, deleted_at text, payload_json text not null)`);
  const insert = db.prepare('insert into orchestration_v2_projection_threads values (?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, 'p1', row.title ?? row.id, row.createdAt ?? '2026-11-01T00:00:00.000Z', row.archivedAt ?? null, row.deletedAt ?? null, '{}');
  db.close();
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('finds only listed threads with the old side chat prefix, oldest first', () => {
  const { file, cleanup } = fixture([
    { id: `${OLD_SIDE_CHAT_PREFIX}b`, createdAt: '2026-11-02T00:00:00.000Z' },
    { id: `${OLD_SIDE_CHAT_PREFIX}a`, createdAt: '2026-11-01T00:00:00.000Z' },
    { id: `${OLD_SIDE_CHAT_PREFIX}archived`, archivedAt: '2026-11-03T00:00:00.000Z' },
    { id: `${OLD_SIDE_CHAT_PREFIX}deleted`, deletedAt: '2026-11-03T00:00:00.000Z' },
    { id: OLD_SIDE_CHAT_PREFIX },
    { id: 'side-chatty' },
    { id: 'side_chat:x' },
    { id: 'thread-1', title: 'side-chat: in a title' },
    { id: 'Side-Chat:upper' },
  ]);
  try {
    assert.deepEqual(listOldSideChats(file).map((thread) => thread.id), [`${OLD_SIDE_CHAT_PREFIX}a`, `${OLD_SIDE_CHAT_PREFIX}b`]);
  } finally { cleanup(); }
});

test('reads without writing: the fixture is unchanged and opens read-only', () => {
  const { file, cleanup } = fixture([{ id: `${OLD_SIDE_CHAT_PREFIX}a` }]);
  try {
    listOldSideChats(file);
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare('select count(*) as n from orchestration_v2_projection_threads where archived_at is null').get().n, 1);
    assert.throws(() => db.exec("update orchestration_v2_projection_threads set title = 'x'"), /readonly/i);
    db.close();
  } finally { cleanup(); }
});

test('archives only reviewed ids and refuses the run when an unreviewed one is listed', () => {
  const found = [{ id: `${OLD_SIDE_CHAT_PREFIX}a` }, { id: `${OLD_SIDE_CHAT_PREFIX}b` }];
  // Reviewed a, b, c; c is already archived, so it is skipped.
  assert.deepEqual(planArchive(found, [`${OLD_SIDE_CHAT_PREFIX}a`, `${OLD_SIDE_CHAT_PREFIX}b`, `${OLD_SIDE_CHAT_PREFIX}c`]),
    { archive: [`${OLD_SIDE_CHAT_PREFIX}a`, `${OLD_SIDE_CHAT_PREFIX}b`], unexpected: [] });
  // b was not reviewed: nothing is archived.
  assert.deepEqual(planArchive(found, [`${OLD_SIDE_CHAT_PREFIX}a`]), { archive: [], unexpected: [`${OLD_SIDE_CHAT_PREFIX}b`] });
  // A replay after the archive finds nothing.
  assert.deepEqual(planArchive([], [`${OLD_SIDE_CHAT_PREFIX}a`]), { archive: [], unexpected: [] });
});
