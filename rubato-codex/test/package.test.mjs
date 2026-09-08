import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('the plugin exposes exactly the six portable workflow skills', async () => {
  const expected = ['agent-taskforce', 'codex-discusser', 'codex-reviewer', 'dispatched', 'dispatching', 'keep-simple'];
  const entries = await readdir(path.join(root, 'skills'), { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expected);
  for (const name of expected) {
    const source = await read(`skills/${name}/SKILL.md`);
    assert.match(source, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(source, /\ndescription: .+\n/);
    assert.doesNotMatch(source, /\/Users\/|\/opt\/homebrew\//);
  }
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

test('native runtime policy does not import the unready Rubato provider catalog', async () => {
  const policy = await read('skills/agent-taskforce/references/model-allocation.md');
  assert.match(policy, /GPT models actually\nadvertised/);
  assert.match(policy, /multi-provider routing are not integrated yet/);
  assert.doesNotMatch(policy, /gpt-5\.6-sol|cursor\/|xai\//);
  const adapter = await read('skills/agent-taskforce/runtimes/codex.md');
  assert.doesNotMatch(adapter, /sync-codex-roles|\/Users\/|\/opt\/homebrew\//);
  assert.match(adapter, /model-allocation\.md/);
});
