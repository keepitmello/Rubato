import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkspaceFile } from '../overlay/apps/server/src/workspace/createWorkspaceFile.ts';

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-note-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('creates a Markdown file in missing folders and preserves its contents', async (t) => {
  const root = await workspace(t);
  await createWorkspaceFile(root, 'notes/기획.md', '# 기획\n\n본문\n');
  assert.equal(await readFile(path.join(root, 'notes/기획.md'), 'utf8'), '# 기획\n\n본문\n');
});

test('existing files and racing creates never overwrite the first contents', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'existing.md'), 'keep this');
  await assert.rejects(createWorkspaceFile(root, 'existing.md', 'replace'), /already exists/);
  assert.equal(await readFile(path.join(root, 'existing.md'), 'utf8'), 'keep this');
  const results = await Promise.allSettled([
    createWorkspaceFile(root, 'race.md', 'first'),
    createWorkspaceFile(root, 'race.md', 'second'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(['first', 'second'].includes(await readFile(path.join(root, 'race.md'), 'utf8')));
});

test('rejects traversal and links without writing outside the repository', async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  for (const name of ['../escape.md', '/tmp/escape.md', 'C:\\escape.md', 'a/../../escape.md']) {
    await assert.rejects(createWorkspaceFile(root, name, 'no'));
  }
  await symlink(outside, path.join(root, 'linked'));
  await assert.rejects(createWorkspaceFile(root, 'linked/escape.md', 'no'), /linked folder/);
  await assert.rejects(readFile(path.join(outside, 'escape.md')), { code: 'ENOENT' });
  await writeFile(path.join(outside, 'keep.md'), 'keep');
  await symlink(path.join(outside, 'keep.md'), path.join(root, 'leaf.md'));
  await assert.rejects(createWorkspaceFile(root, 'leaf.md', 'no'), /already exists/);
  assert.equal(await readFile(path.join(outside, 'keep.md'), 'utf8'), 'keep');
});

test('new Markdown note uses the real create/read/write RPCs without replacing an existing file', {
  skip: !process.env.T3_SOURCE, timeout: 120_000,
}, async (t) => {
  const source = process.env.T3_SOURCE;
  const directory = path.join(source, 'apps/server/src');
  const upstream = await readFile(path.join(directory, 'server.test.ts'), 'utf8');
  const marker = '  it.effect("routes websocket rpc projects.writeFile",';
  assert.equal(upstream.split(marker).length, 2);
  const fixture = await readFile(new URL('./fixtures/markdown-notes.ts', import.meta.url), 'utf8');
  const generated = path.join(directory, `RubatoMarkdownNotes.${process.pid}.test.ts`);
  await writeFile(generated, upstream.replace(marker, fixture + '\n' + marker), { flag: 'wx' });
  t.after(() => unlink(generated));
  try {
    const result = await promisify(execFile)(
      path.join(source, 'node_modules/.bin/vp'),
      ['test', 'run', path.relative(path.join(source, 'apps/server'), generated), '-t', 'Rubato markdown notes'],
      { cwd: path.join(source, 'apps/server'), timeout: 110_000, maxBuffer: 4 * 1024 * 1024 },
    );
    t.diagnostic(result.stdout);
  } catch (error) {
    assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
  }
});
