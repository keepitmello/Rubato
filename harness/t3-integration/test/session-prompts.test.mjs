import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INLINE_PROMPT_LABEL, listSessionPrompts, openSessionPromptFolder, resolveSessionPrompt, SESSION_PROMPT_LIMIT,
} from '../src/session-prompts.mjs';
import { SYSTEM_PROMPT_LIMIT } from '../../pi-server/src/session-files.mjs';

async function places(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, folder: path.join(root, 'prompts'), extras: [path.join(root, 'Documents', 'SOUL.md')] };
}

test('the library lists the prompt folder by name, then SOUL.md when it exists', async (t) => {
  const where = await places(t);
  assert.deepEqual(await listSessionPrompts(where), [], 'a missing folder is an empty library');
  await mkdir(where.folder, { recursive: true });
  await mkdir(path.dirname(where.extras[0]), { recursive: true });
  await writeFile(path.join(where.folder, 'zeta.md'), 'Z');
  await writeFile(path.join(where.folder, 'alpha.txt'), 'A');
  await writeFile(path.join(where.folder, '.hidden.md'), 'H');
  await writeFile(path.join(where.folder, 'image.png'), 'P');
  await mkdir(path.join(where.folder, 'dir.md'));
  await writeFile(where.extras[0], 'SOUL');
  assert.deepEqual((await listSessionPrompts(where)).map((entry) => [entry.label, entry.source]), [
    ['alpha', path.join(where.folder, 'alpha.txt')],
    ['zeta', path.join(where.folder, 'zeta.md')],
    ['SOUL', where.extras[0]],
  ]);
});

test('a listed file is read when chosen; anything else on disk is refused', async (t) => {
  const where = await places(t);
  await mkdir(where.folder, { recursive: true });
  const file = path.join(where.folder, 'pirate.md');
  await writeFile(file, 'You are a pirate.\n');
  assert.deepEqual(await resolveSessionPrompt({ id: `file:${file}` }, where),
    { text: 'You are a pirate.\n', label: 'pirate', source: file });
  await assert.rejects(resolveSessionPrompt({ id: `file:${path.join(where.root, 'secret.md')}` }, where), /no longer in the prompt folder/);
  await writeFile(path.join(where.folder, 'blank.md'), '  \n');
  await assert.rejects(resolveSessionPrompt({ id: `file:${path.join(where.folder, 'blank.md')}` }, where), /empty/);
});

test('text written for one conversation keeps its name or gets the inline name', async () => {
  assert.deepEqual(await resolveSessionPrompt({ text: 'Be brief.', label: '  terse ' }), { text: 'Be brief.', label: 'terse' });
  assert.deepEqual(await resolveSessionPrompt({ text: 'Be brief.' }), { text: 'Be brief.', label: INLINE_PROMPT_LABEL });
  await assert.rejects(resolveSessionPrompt({ text: 'x'.repeat(SESSION_PROMPT_LIMIT + 1) }), /longer than/);
  assert.equal(SESSION_PROMPT_LIMIT, SYSTEM_PROMPT_LIMIT, 'the app refuses what pi-server would refuse');
});

test('opening the folder creates it first', async (t) => {
  const where = await places(t);
  const opened = [];
  assert.deepEqual(await openSessionPromptFolder(where, { open: async (folder) => { opened.push(folder); } }), { folder: where.folder });
  assert.deepEqual(opened, [where.folder]);
  assert.deepEqual(await listSessionPrompts(where), []);
});
