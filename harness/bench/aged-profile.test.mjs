import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateAgedProfile } from './aged-profile.mjs';
import { SessionFiles } from '../pi-server/src/session-files.mjs';
import { databasePath } from '../rubato-pi/src/context-notes/store.mjs';

const options = { sessions: 40, artifacts: 20, large: '6,4', companionMb: 3, samples: 12, sizeScale: 1, seed: 7, now: Date.UTC(2026, 10, 21), log: () => {} };

/** The conversations' bytes, with the profile's own location taken out (their folders name it). */
async function digest(out) {
  const root = path.join(out, 'agent');
  const encoded = out.replace(/^\//, '').replace(/[/\\:]/g, '-');
  const plain = (text) => text.replaceAll(out, '<out>').replaceAll(encoded, '<out>');
  const hash = createHash('sha256');
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      // The archives and index carry SQLite pages and the engine's own stat keys; the conversations are the profile.
      if (entry.isDirectory()) await walk(full);
      else if (full.endsWith('.jsonl') || full.endsWith('.txt')) hash.update(plain(path.relative(root, full))).update(plain(await readFile(full, 'utf8')));
    }
  };
  await walk(root);
  return hash.digest('hex');
}

test('the same options build the same profile, and the engine reads every conversation in it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-aged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await generateAgedProfile({ ...options, out: path.join(root, 'a') });
  const second = await generateAgedProfile({ ...options, out: path.join(root, 'b') });
  assert.equal(await digest(path.join(root, 'a')), await digest(path.join(root, 'b')));

  const files = new SessionFiles(first.sessionsDir);
  const listed = await files.list();
  await files.close();
  assert.equal(listed.length, options.sessions);
  const companion = listed.find((item) => item.id === first.conversations.companion.id);
  assert.equal(companion.companion, true);
  assert.equal(companion.title, 'Segno');
  assert.deepEqual(first.conversations.large.map((item) => Math.round(item.bytes / 1e6)), [6, 4]);
  assert.ok(listed.some((item) => path.dirname(item.file) !== first.sessionsDir), 'some conversations sit in per-folder directories');
  // Every conversation of the last 14 days, the companion's included, has its notes archive.
  assert.ok(first.totals.notesArchives >= 3);
  await readFile(databasePath(first.agentDir, first.conversations.companion.id));
  assert.equal((await readdir(path.join(first.agentDir, 'speed-index', 'samples'))).length, options.samples);
  assert.equal(second.totals.conversationBytes, first.totals.conversationBytes);
});
