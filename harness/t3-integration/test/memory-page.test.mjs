// The memory page's newer reads, on a throwaway HOME: a companion's own records (read-only, with
// links out of its home refused), one question's history with diffs, this week per project, and the
// two cached model answers (overlaps, project lines) with a stand-in model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../src/memory/service.mjs';
import { bulletsBySection, dailyHeadline, splitRefs } from '../src/memory/companion.mjs';
import { cleanPairs } from '../src/memory/insights.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

const STATUS = `# 현황판

## 열린 것
- 카줌: 셀러 첫 다섯 곳 메일 vs 수찬 전화 오빠 답 대기. (daily 11-06)
- VaultOne LBT: 리드가 구현 중.
  완성되면 운영 배포.

## 지금 이 순간
`;
const TO_ASK = `# 오빠한테 물어볼 것

- 메일 IMAP 인증이 17일째 실패해. 비번이 바뀌었는지. (꿈 10-22~11-07)
- [user 조각 제안] "지금 서 있는 자리"에 카줌 한 줄. (daily 11-03)
`;
const USER = `# 오빠

> 큰 윤곽 말고 겪으며 안 결만.

## 지금

- 리드 모델은 비용과 크기로 본다. API로 돈이 나가는 모델은 싫어한다. (daily 11-02)
- 맡길 땐 끝까지 맡긴다.

## 이야기

- 옛날 이야기.
`;
const US = `# 오빠랑 나

## 지금

- 호칭은 언제나 "오빠". (daily 10-21)
`;

async function companionHome(home) {
  const dir = path.join(home, '.rubato', 'companion');
  const memory = path.join(dir, 'memory');
  for (const sub of ['diary', 'weekly', 'entities', 'ref']) await mkdir(path.join(memory, sub), { recursive: true });
  await mkdir(path.join(dir, 'dream', 'runs', 'dream-1'), { recursive: true });
  await writeFile(path.join(memory, 'status.md'), STATUS);
  await writeFile(path.join(memory, 'to-ask.md'), TO_ASK);
  await writeFile(path.join(memory, 'user.md'), USER);
  await writeFile(path.join(memory, 'us.md'), US);
  await writeFile(path.join(memory, '2026-11-08.md'), '\n## 11-07 20시~11-08 01시: 정식판 배포, 롤백\n- 일\n\n## 01시: 홈 A/B 반려\n- 일\n');
  await writeFile(path.join(memory, '2026-11-07.md'), '\n## 스테이크 설명서\n- 일\n');
  await writeFile(path.join(memory, 'diary', '2026-11-08.md'), '## 밤\n떨렸다.\n');
  await writeFile(path.join(memory, 'diary', '2026-11-06.md'), '## 낮\n조용했다.\n');
  await writeFile(path.join(memory, 'weekly', '2026-W44.md'), '# 2026-W44\n\n## 이야기\n\n카줌이 생긴 주였어. 그리고 더.\n');
  await writeFile(path.join(memory, 'entities', '수찬.md'), '---\ntype: entity\ncanonical: 수찬\naka: [데란, Deran]\nsummary: 오빠의 소꿉친구.\nupdated: 2026-11-06\n---\n\n# 수찬\n');
  await writeFile(path.join(memory, 'entities', 'aliases.md'), '# aliases\n');
  await writeFile(path.join(dir, 'dream', 'state.json'), JSON.stringify({ lastRunAt: '2026-11-09T04:07:23+09:00', lastRunId: 'dream-1', lastStatus: 'failed', blocks: { weekly: { lastAt: '2026-11-01T04:07:26+09:00' } } }));
  await writeFile(path.join(dir, 'dream', 'runs', 'dream-1', 'run.json'), JSON.stringify({ status: 'failed', reason: 'every model failed', attempts: [{ model: 'anthropic/claude-opus-5-5', ok: false, error: 'rate limit' }] }));
  // A repository document linked in for reading; the page must not follow it.
  const outside = path.join(home, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.md'), 'not segno\n');
  await symlink(path.join(outside, 'secret.md'), path.join(memory, 'ref', 'secret.md'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'add', 'memory');
  git(dir, 'commit', '-q', '-m', 'home: 시작');
  await writeFile(path.join(memory, 'user.md'), USER.replace('맡길 땐 끝까지 맡긴다.', '맡길 땐 끝까지 맡긴다. 로그인까지.'));
  git(dir, 'commit', '-q', '-am', 'dream: 꿈 11-07');
  return dir;
}

async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-memory-page-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.rubato'), { recursive: true });
  await writeFile(path.join(home, '.rubato', 'rubato.jsonc'), '{ "memory": { "dream": { "models": [{ "model": "xai/grok-4.7", "reasoning": "medium" }] } } }\n');
  const companion = await companionHome(home);
  const agents = path.join(home, '.rubato', 'memory', 'agents');
  const repo = path.join(agents, 'proj', 'repo');
  await mkdir(path.join(repo, 'decisions'), { recursive: true });
  await mkdir(path.join(repo, 'reference'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'decisions', 'app-rewind.md'), '---\ndescription: How rewind works\n---\n# App rewind does not change the session\n\n## Conclusion\n- First answer.\n');
  await writeFile(path.join(repo, 'reference', 'paths.md'), '---\ndescription: Where things live\n---\n\n## Conclusion\n- Here.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'dream: first answers');
  await writeFile(path.join(repo, 'decisions', 'app-rewind.md'), '---\ndescription: How rewind works\n---\n# App rewind does not change the session\n\n## Conclusion\n- Second answer.\n');
  git(repo, 'commit', '-q', '-am', 'Rewind keeps the session', '-m', 'Rubato-Writer: settings');
  // A store an agent opened and never wrote to.
  const empty = path.join(agents, 'quiet', 'repo');
  await mkdir(empty, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', empty]);
  const view = { topics: [{ id: 'working-style', title: null, items: [{ path: 'constraints/approve-paid-runs.md', text: 'Ask first', conclusion: ['Ask before paid runs.'] }] }] };
  const service = createMemoryService({
    env: { ...process.env, HOME: home, RUBATO_MEMORY_HOME: '', RUBATO_COMPANION_HOME: '', RUBATO_DEFAULT_COMPANION_HOME: '', RUBATO_COMPANIONS_FILE: '' },
    msearch: '/nonexistent/msearch',
    // Stands in for `rubato memory view --json`: the shared user memory.
    rubato: ['/bin/sh', '-c', `printf '%s' '${JSON.stringify(view)}'`, 'sh'],
    complete: options.complete ?? (async (request) => ({ model: 'test/model', text: request.prompt.includes('List A') ? '{"pairs":[]}' : '{"lines":{}}' })),
  });
  return { home, companion, repo, service };
}

test('a companion\'s records read as the page shows them', async (t) => {
  const { service } = await fixture(t);
  const view = await service.handle('companion-memory', {});
  assert.equal(view.id, 'segno');
  assert.equal(view.status.path, 'memory/status.md');
  assert.deepEqual(view.status.sections.map((section) => [section.title, section.items.length]), [['열린 것', 2]]);
  assert.equal(view.status.sections[0].items[0].refs, 'daily 11-06');
  assert.equal(view.status.sections[0].items[1].text, 'VaultOne LBT: 리드가 구현 중. 완성되면 운영 배포.');
  assert.deepEqual(view.questions.items.map((item) => item.proposal), [false, true]);
  assert.equal(view.questions.items[1].text, '"지금 서 있는 자리"에 카줌 한 줄.');
  // Only the current section of user.md and us.md, each line tagged with its file.
  assert.deepEqual(view.about.map((line) => [line.kind, line.text]), [
    ['user', '리드 모델은 비용과 크기로 본다. API로 돈이 나가는 모델은 싫어한다.'],
    ['user', '맡길 땐 끝까지 맡긴다. 로그인까지.'],
    ['us', '호칭은 언제나 "오빠".'],
  ]);
  assert.deepEqual(view.records.map((day) => [day.date, Boolean(day.daily), Boolean(day.diary)]), [
    ['2026-11-08', true, true], ['2026-11-07', true, false], ['2026-11-06', false, true],
  ]);
  assert.equal(view.records[0].headline, '정식판 배포, 롤백 · 홈 A/B 반려');
  assert.deepEqual(view.weekly, [{ week: '2026-W44', path: 'memory/weekly/2026-W44.md', headline: '카줌이 생긴 주였어.' }]);
  assert.deepEqual(view.entities.map((entity) => [entity.name, entity.aka]), [['수찬', ['데란', 'Deran']]]);
  assert.equal(view.dream.lastStatus, 'failed');
  assert.equal(view.dream.attempts[0].error, 'rate limit');
  // Ids hold across reads, so a sent mark finds its line again.
  assert.deepEqual((await service.handle('companion-memory', {})).about.map((line) => line.id), view.about.map((line) => line.id));
});

test('the page reads only inside the companion\'s memory and never follows a link out', async (t) => {
  const { service, companion } = await fixture(t);
  const read = await service.handle('companion-file', { path: 'memory/user.md' });
  assert.match(read.content, /로그인까지/);
  for (const bad of ['memory/ref/secret.md', '../outside/secret.md', 'notes/held.md', 'memory/../settings.json', '/etc/passwd', 'memory/status.json']) {
    await assert.rejects(service.handle('companion-file', { path: bad }), (error) => error.status === 400 || error.status === 404, bad);
  }
  const found = await service.handle('companion-search', { query: '수찬 전화' });
  assert.deepEqual(found.results.map((hit) => hit.path), ['memory/status.md']);
  assert.equal((await service.handle('companion-search', { query: 'not segno' })).results.length, 0, 'search does not follow links');
  const history = await service.handle('companion-history', { path: 'memory/user.md' });
  assert.deepEqual(history.commits.map((commit) => commit.subject), ['dream: 꿈 11-07', 'home: 시작']);
  const diff = await service.handle('companion-diff', { path: 'memory/user.md', sha: history.commits[0].sha });
  assert.match(diff.diff, /^\+- 맡길 땐 끝까지 맡긴다\. 로그인까지\./m);
  const changes = await service.handle('companion-changes', { since: '2000-01-01T00:00:00Z' });
  assert.deepEqual(changes.changes.map((change) => change.subject), ['dream: 꿈 11-07', 'home: 시작']);
  assert.deepEqual(changes.changes[0].files, ['memory/user.md']);
  // Nothing the page did wrote inside the home.
  assert.equal(git(companion, 'status', '--porcelain', '--', 'memory'), '');
});

test('a line the person answered stays marked as sent, outside the companion\'s home', async (t) => {
  const { service, home, companion } = await fixture(t);
  const before = await service.handle('companion-memory', {});
  const question = before.questions.items[0];
  await service.handle('companion-sent', { itemId: question.id, at: '2026-11-09T10:00:00.000Z' });
  const after = await service.handle('companion-memory', {});
  assert.equal(after.questions.items[0].sent, '2026-11-09T10:00:00.000Z');
  assert.equal(after.questions.items[1].sent, undefined);
  const kept = JSON.parse(await readFile(path.join(home, '.rubato', 'cache', 'memory-page', 'companion-sent.json'), 'utf8'));
  assert.deepEqual(Object.keys(kept.segno), [question.id]);
  assert.equal(git(companion, 'status', '--porcelain', '--', 'memory'), '');
  await assert.rejects(service.handle('companion-sent', { itemId: '../x' }), (error) => error.status === 400);
  await assert.rejects(service.handle('companion-memory', { companionId: 'nobody' }), (error) => error.status === 404);
});

test('a project lists its questions, and each question its history with diffs', async (t) => {
  const { service } = await fixture(t);
  const { stores } = await service.handle('stores');
  assert.deepEqual(stores.map((store) => [store.store, store.files, store.empty]).sort(), [['proj', 2, false], ['quiet', 0, true]]);
  const { files } = await service.handle('files', { store: 'proj' });
  assert.deepEqual(files.map((file) => [file.path, file.title, file.kind, file.writer]), [
    ['decisions/app-rewind.md', 'App rewind does not change the session', 'decision', 'you'],
    ['reference/paths.md', null, 'reference', 'dream'],
  ]);
  const history = await service.handle('file-history', { store: 'proj', path: 'decisions/app-rewind.md' });
  assert.deepEqual(history.commits.map((commit) => [commit.writer, commit.change, commit.text]), [
    ['you', 'modified', 'Rewind keeps the session'],
    ['dream', 'added', 'first answers'],
  ]);
  const diff = await service.handle('file-diff', { store: 'proj', path: 'decisions/app-rewind.md', sha: history.commits[0].sha });
  assert.match(diff.diff, /^-- First answer\.$/m);
  assert.match(diff.diff, /^\+- Second answer\.$/m);
  await assert.rejects(service.handle('file-diff', { store: 'proj', path: 'decisions/app-rewind.md', sha: 'HEAD~1' }), (error) => error.status === 400);
  await assert.rejects(service.handle('file-history', { store: 'proj', path: '../x.md' }), (error) => error.status === 400);
});

test('this week reads per project: what changed, who wrote it, and the titles', async (t) => {
  const { service } = await fixture(t);
  const { projects } = await service.handle('project-changes', {});
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].writers, { dream: 1, session: 0, you: 1 });
  assert.deepEqual(projects[0].files.map((file) => [file.path, file.change, file.kind, file.title]).sort(), [
    ['decisions/app-rewind.md', 'added', 'decision', 'App rewind does not change the session'],
    ['reference/paths.md', 'added', 'reference', 'Where things live'],
  ]);
});

test('overlaps and project lines come from one model call each, kept until their input changes', async (t) => {
  const requests = [];
  const { service, home } = await fixture(t, {
    complete: async (request) => {
      requests.push(request);
      if (request.prompt.includes('List A')) {
        const id = /\[(user-[0-9a-f]{12})\] 리드 모델/.exec(request.prompt)[1];
        return { model: 'test/model', text: `Sure:\n\`\`\`json\n{"pairs":[{"b":"${id}","a":"constraints/approve-paid-runs.md","relation":"overlap","note":"둘 다 돈 드는 실행 얘기야."},{"b":"user-000000000000","a":"constraints/approve-paid-runs.md","relation":"same"}]}\n\`\`\`` };
      }
      return { model: 'test/model', text: '{"lines":{"proj":"되감기 방식 · 경로 정리","ghost":"no"}}' };
    },
  });
  const first = await service.handle('insights', { language: 'Korean' });
  assert.equal(first.overlaps.segno.status, 'working');
  assert.equal(first.projects.status, 'working');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ready = await service.handle('insights', { language: 'Korean' });
  assert.equal(ready.overlaps.segno.status, 'ready');
  assert.deepEqual(ready.overlaps.segno.value.pairs.map((pair) => [pair.shared, pair.relation, pair.note]), [
    ['constraints/approve-paid-runs.md', 'overlap', '둘 다 돈 드는 실행 얘기야.'],
  ]);
  assert.deepEqual(ready.projects.value.lines, { proj: '되감기 방식 · 경로 정리' });
  assert.equal(requests.length, 2);
  // The prompt carries the shared record's English conclusion and only Segno's lines about the person (not us.md).
  const overlapPrompt = requests.find((request) => request.prompt.includes('List A')).prompt;
  assert.match(overlapPrompt, /Write notes in: Korean/);
  assert.match(overlapPrompt, /\[constraints\/approve-paid-runs\.md\] Ask before paid runs\./);
  assert.doesNotMatch(overlapPrompt, /호칭은/);
  // Nothing changed: no new call.
  await service.handle('insights', { language: 'Korean' });
  assert.equal(requests.length, 2);
  // Another language is another answer; start: false only reads.
  const english = await service.handle('insights', { language: 'English', start: false });
  assert.equal(english.overlaps.segno.status, 'idle');
  assert.equal(english.overlaps.segno.stale, true);
  assert.equal(requests.length, 2);
  const cache = JSON.parse(await readFile(path.join(home, '.rubato', 'cache', 'memory-page', 'insights.json'), 'utf8'));
  assert.deepEqual(Object.keys(cache).sort(), ['overlaps:segno', 'projects']);
});

test('a failed model call is kept for a while instead of retried on every look', async (t) => {
  let calls = 0;
  const { service } = await fixture(t, { complete: async () => { calls += 1; throw new Error('xai/grok-4.7 exited 1: quota'); } });
  await service.handle('insights', { language: 'Korean' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const failed = await service.handle('insights', { language: 'Korean' });
  assert.equal(failed.overlaps.segno.status, 'failed');
  assert.match(failed.overlaps.segno.error, /quota/);
  assert.equal(calls, 2);
});

test('markdown helpers', () => {
  assert.deepEqual(splitRefs('한 줄 (daily 10-22·10-23)'), { text: '한 줄', refs: 'daily 10-22·10-23' });
  assert.deepEqual(splitRefs('괄호 없음'), { text: '괄호 없음', refs: null });
  assert.equal(dailyHeadline('## 12:50 SS001 답\n- x\n## 저녁: 정리\n'), '12:50 SS001 답 · 정리');
  assert.deepEqual(bulletsBySection('# T\n\n## A\n- one\n  more\n- two\n\n## B\ntext\n').map((section) => [section.title, section.items.map((item) => item.text)]), [
    ['A', ['one more', 'two']], ['B', []],
  ]);
  assert.deepEqual(cleanPairs({ pairs: [{ b: 'x', a: 'y', relation: 'conflict', note: 'n' }, { b: 'x', a: 'y', relation: 'same' }, { b: 'z', a: 'y', relation: 'maybe' }] },
    { shared: [{ id: 'y' }], lines: [{ id: 'x' }, { id: 'z' }] }), [{ line: 'x', shared: 'y', relation: 'conflict', note: 'n' }]);
});
