import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('the plugin exposes every manifest skill plus the Codex-native skills', async () => {
  const manifest = JSON.parse(await read('skill-bundle.json'));
  const outputName = (name) => manifest.renames[name] || name;
  const expected = [
    ...manifest.managed.map(outputName),
    ...manifest.conditional.map(outputName),
    ...manifest.preserved.map(outputName),
    ...manifest.nativeOnly,
  ].sort();
  const entries = await readdir(path.join(root, 'skills'), { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expected);
  for (const name of expected) {
    const source = await read(`skills/${name}/SKILL.md`);
    assert.match(source, new RegExp(`^---\\nname: ["']?${name}["']?\\n`));
    assert.match(source, /\ndescription: .+\n/);
    assert.doesNotMatch(source, /\/Users\/|\/opt\/homebrew\//);
  }
});

test('package scripts build and check the manifest-driven skill bundle', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['build:skills'], 'node scripts/build-skills.mjs');
  assert.equal(pkg.scripts['check:skills'], 'node scripts/build-skills.mjs --check');
  assert.match(pkg.scripts.test, /npm run check:skills/);
});

test('generated native roles carry receiving contracts but never override lead model selection', async () => {
  for (const suffix of ['owner', 'verifier', 'helper']) {
    const source = await read(`agents/taskforce_${suffix}.toml`);
    assert.doesNotMatch(source, /^(?:model|model_reasoning_effort)\s*=/m);
    assert.doesNotMatch(source, /\/Users\/|\/opt\/homebrew\//);
    const instructions = JSON.parse(source.match(/^developer_instructions = (.+)$/m)[1]);
    assert.match(instructions, /# Taskforce role: taskforce_/);
    assert.match(instructions, /# Dispatched/);
    assert.match(instructions, /Roles are not pinned to a model/);
  }
});

test('model routing has one guide and keeps provider policy separate from native execution', async () => {
  const guide = await read('skills/model-guide/SKILL.md');
  const policy = await read('skills/agent-taskforce/references/model-allocation.md');
  const adapter = await read('skills/agent-taskforce/runtimes/codex.md');
  assert.match(guide, /providers\.json/);
  assert.match(policy, /model-guide/);
  assert.match(adapter, /model-allocation\.md/);
  for (const source of [guide, policy, adapter]) {
    assert.doesNotMatch(source, /sync-codex-roles|\/Users\/|\/opt\/homebrew\//);
  }
});
