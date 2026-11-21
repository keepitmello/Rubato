#!/usr/bin/env node
// Archives the side chats Rubato made before T3 had its own (cutover step of intent
// t3-v0-1-11-bump). Those threads carry an id prefix that nothing else uses; T3's own side
// chats do not, and T3 v0.1.11 lists the old ones as ordinary threads. They are archived,
// not deleted, so Settings › Archive brings any of them back.
//
//   node harness/t3-integration/archive-old-side-chats.mjs                 list them
//   node harness/t3-integration/archive-old-side-chats.mjs --expect <id,id,...>   archive them
//        [--t3-home ~/.rubato/t3-home] [--t3 ~/.rubato/t3-source]
//
// The state database is only read (read-only connection) to find them; the archive goes
// through the running server (`t3 thread archive`, thread-archive-edits.mjs), so it needs
// the v0.1.11 app running. It archives only the ids the person reviewed (--expect): a listed
// side chat outside that list stops the run before anything is sent, and reviewed ids that
// are already archived are skipped, so a second run finds nothing to do.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The id prefix of Rubato's own side chat threads (its removed side-chat module). */
export const OLD_SIDE_CHAT_PREFIX = 'side-chat:';

/** Old side chats still listed: not archived, not deleted. Oldest first. */
export function listOldSideChats(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(
      `select thread_id as id, title, project_id as projectId, created_at as createdAt
         from orchestration_v2_projection_threads
        where substr(thread_id, 1, ?) = ? and length(thread_id) > ?
          and archived_at is null and deleted_at is null
        order by created_at, thread_id`,
    ).all(OLD_SIDE_CHAT_PREFIX.length, OLD_SIDE_CHAT_PREFIX, OLD_SIDE_CHAT_PREFIX.length)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/**
 * What to archive: the listed old side chats, all of which must be in `expected` (the reviewed
 * ids). Reviewed ids no longer listed are already archived or gone and are skipped.
 */
export function planArchive(found, expected) {
  const reviewed = new Set(expected);
  const unexpected = found.filter((thread) => !reviewed.has(thread.id)).map((thread) => thread.id);
  return { archive: unexpected.length === 0 ? found.map((thread) => thread.id) : [], unexpected };
}

/** Archives `ids` through the running server's CLI; returns its exit status. */
export function archiveThroughServer({ t3, t3Home, ids }) {
  const result = spawnSync(process.execPath,
    [path.join(t3, 'apps/server/dist/bin.mjs'), 'thread', 'archive', '--base-dir', t3Home, ...ids],
    { stdio: 'inherit' });
  return result.status ?? 1;
}

async function main() {
  const { values } = parseArgs({ options: {
    expect: { type: 'string' },
    't3-home': { type: 'string', default: path.join(os.homedir(), '.rubato/t3-home') },
    t3: { type: 'string', default: path.join(os.homedir(), '.rubato/t3-source') },
  } });
  const t3Home = path.resolve(values['t3-home']);
  const database = path.join(t3Home, 'userdata/statev2.sqlite');
  if (!existsSync(database)) throw new Error(`No state database at ${database}`);
  const found = listOldSideChats(database);
  for (const thread of found) console.log(`${thread.id}\t${thread.createdAt}\t${thread.title}`);
  if (values.expect === undefined) {
    console.log(`${found.length} old side chat(s) listed. Archive them with --expect ${found.map((thread) => thread.id).join(',') || '<ids>'}`);
    return 0;
  }
  const expected = values.expect.split(',').map((id) => id.trim()).filter(Boolean);
  const plan = planArchive(found, expected);
  if (plan.unexpected.length > 0) {
    console.error(`Not reviewed, nothing archived: ${plan.unexpected.join(', ')}`);
    return 1;
  }
  if (plan.archive.length === 0) { console.log('No old side chats to archive.'); return 0; }
  const status = archiveThroughServer({ t3: path.resolve(values.t3), t3Home, ids: plan.archive });
  const left = listOldSideChats(database);
  if (status !== 0 || left.length > 0) {
    console.error(`Archive incomplete: exit ${status}, ${left.length} old side chat(s) still listed.`);
    return 1;
  }
  console.log(`Archived ${plan.archive.length} old side chat(s).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
}
