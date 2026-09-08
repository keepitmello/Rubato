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

test('user documentation separates provider routing from login and execution proof', async () => {
  const readme = await read('README.md');
  const architecture = await read('docs/architecture.md');
  for (const source of [readme, architecture]) {
    assert.match(source, /rubato-codex\/providers\.json/);
    assert.match(source, /routing 정책/);
    assert.match(source, /실제.*모델/);
    assert.doesNotMatch(source, /여섯 스킬|multi-provider routing are not integrated yet/);
  }
  assert.match(readme, /--providers none/);
  assert.match(readme, /외부 provider 로그인은 별도로/);
  assert.match(readme, /ocx agent subagents status/);
  assert.match(readme, /ocx agent subagents set gpt-5\.6-sol,cursor\/claude-fable-5-1,cursor\/claude-opus-5,xai\/grok-4\.6,cursor\/gemini-3\.8-flash/);
  assert.doesNotMatch(readme, /ocx agent subagents set gpt-5\.6-sol cursor\//);
  assert.match(readme, /최대 다섯 모델/);
  assert.match(readme, /Provider 등록, 모델 roster 등록, 인증, 실제 호출 성공은 각각 다른 상태/);
  assert.match(readme, /--disable-skill "\$HOME\/\.agents\/skills\/outpost\/SKILL\.md"/);
  assert.match(readme, /원본을 이동·수정·삭제하지 않습니다/);
  assert.match(readme, /uninstall하면 관리 블록이 제거/);
  assert.match(architecture, /shared proxy.*강제하지/);
});
