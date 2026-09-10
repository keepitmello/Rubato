import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync,
  symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { IntentStore, reference, decode, main } from '../scripts/intent.mjs';

const body = `# Intent: Keep one authority\n\n## Problem\nAgents lose the requested result.\n\n## Proposed outcome\nResumed work reads the same accepted intent.\n\n## Constraints\nUser: preserve the current delivery contract.\n\n## Open questions\nNone for the accepted scope.\n`;
const helper = fileURLToPath(new URL('../scripts/intent.mjs', import.meta.url));
function setup(t, home) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-intent-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new IntentStore(dir, home) };
}
const create = (store, id = 'one') => store.create({ id, source: 'user:request-1', body });
const active = (store, id = 'one') => {
  const rec = create(store, id);
  return store.activate(id, { expect: rec.sha256, approval: 'user:acceptance-1' });
};

test('empty live listing and index rendering have no write side effects', t => {
  const { dir, store } = setup(t);
  assert.deepEqual(store.list(), []);
  assert.match(store.index(), /Navigation only/);
  assert.deepEqual(readdirSync(dir), []);
});
test('create/read returns a stable project-relative reference and valid scalar metadata', t => {
  const { store } = setup(t);
  const rec = create(store, 'document-authority');
  assert.equal(rec.meta.status, 'draft');
  assert.equal(rec.meta.revision, 1);
  assert.deepEqual(reference(rec), { id: 'document-authority', path: 'intent/document-authority/intent.md', revision: 1, sha256: rec.sha256 });
  assert.match(rec.sha256, /^[a-f0-9]{64}$/);
  assert.equal(store.read('document-authority').body, body);
  assert.equal(rec.meta.approval, null);
});
test('activation records acceptance and invalidates the pre-activation file reference', t => {
  const { store } = setup(t); const rec = create(store);
  assert.throws(() => store.activate('one', { expect: rec.sha256, approval: '' }), /approval/);
  const accepted = store.activate('one', { expect: rec.sha256, approval: 'user:acceptance' });
  assert.equal(store.check('one', { expect: accepted.sha256, active: true }).meta.status, 'active');
  assert.throws(() => store.check('one', { expect: rec.sha256 }), /stale/);
  assert.throws(() => store.activate('one', { expect: accepted.sha256, approval: 'again' }), /only draft/);
});
test('draft is not active and mutation requires a current expected hash', t => {
  const { store } = setup(t); const rec = create(store);
  assert.throws(() => store.check('one', { active: true }), /not active/);
  assert.throws(() => store.revise('one', { source: 'user:change', body }), /requires --expect/);
  assert.throws(() => store.revise('one', { expect: '0'.repeat(64), source: 'user:change', body }), /stale/);
  assert.equal(store.read('one').sha256, rec.sha256);
});
test('revising a requested outcome keeps its ID, increments revision and clears acceptance', t => {
  const { store } = setup(t); const rec = active(store);
  const changed = store.revise('one', { expect: rec.sha256, source: 'user:change', body: body.replace('same accepted', 'same revised and accepted') });
  assert.equal(changed.meta.id, 'one'); assert.equal(changed.meta.revision, 2);
  assert.equal(changed.meta.status, 'draft'); assert.equal(changed.meta.approval, null);
  assert.equal(changed.meta.approved_sha256, null);
  assert.throws(() => store.check('one', { expect: rec.sha256, active: true }), /stale/);
});
test('manual edits to approved content are detected and can be returned to draft', t => {
  const { store } = setup(t); active(store);
  const filename = store.filename('one');
  writeFileSync(filename, readFileSync(filename, 'utf8').replace('same accepted intent', 'a different outcome'));
  assert.throws(() => store.check('one', { active: true }), /approved content changed/);
  assert.throws(() => store.list(), /approved content changed/);
  const raw = store.read('one');
  const recovered = store.revise('one', { expect: raw.sha256, source: 'user:review required', body: raw.body });
  assert.equal(recovered.meta.status, 'draft');
});
test('resuming from another store preserves the intent instead of creating a run copy', t => {
  const { dir, store } = setup(t); const rec = active(store);
  const resumed = new IntentStore(dir);
  assert.deepEqual(reference(resumed.check('one', { expect: rec.sha256, active: true })), reference(rec));
  assert.throws(() => create(resumed), /already exists/);
  assert.throws(() => create(resumed, 'ONE'), /already exists/);
  assert.equal(resumed.list().length, 1);
});
test('unrelated active outcomes may coexist without a global current pointer', t => {
  const { store } = setup(t); active(store, 'a'); active(store, 'b');
  assert.deepEqual(store.list().map(r => r.meta.id), ['a', 'b']);
});
test('fulfillment requires active state and evidence, not a board or session status', t => {
  const { store } = setup(t); const draft = create(store);
  assert.throws(() => store.close('one', { expect: draft.sha256, status: 'fulfilled', evidence: 'test' }), /only active/);
  const rec = store.activate('one', { expect: draft.sha256, approval: 'user:accept' });
  assert.throws(() => store.close('one', { expect: rec.sha256, status: 'fulfilled', evidence: '' }), /real evidence/);
  const closed = store.close('one', { expect: rec.sha256, status: 'fulfilled', evidence: 'accepted artifact/test reference' });
  assert.equal(closed.meta.status, 'fulfilled'); assert.equal(store.list().length, 0);
  assert.equal(store.list({ all: true }).length, 1);
  assert.throws(() => store.check('one', { active: true }), /not active/);
});
test('reopening a completed outcome requires new acceptance on the same record', t => {
  const { store } = setup(t); const rec = active(store);
  const closed = store.close('one', { expect: rec.sha256, status: 'fulfilled', evidence: 'accepted test' });
  const reopened = store.revise('one', { expect: closed.sha256, source: 'user:regression reopened', body });
  assert.equal(reopened.meta.status, 'draft'); assert.equal(reopened.meta.revision, 2);
  assert.equal(reopened.meta.closure_evidence, null);
});
test('supersession needs a different active replacement and preserves history', t => {
  const { store } = setup(t); const rec = active(store); const replacement = create(store, 'replacement');
  assert.throws(() => store.close('one', { expect: rec.sha256, status: 'superseded', evidence: 'user:replace', supersededBy: 'one' }), /itself/);
  assert.throws(() => store.close('one', { expect: rec.sha256, status: 'superseded', evidence: 'user:replace', supersededBy: 'replacement' }), /not active/);
  store.activate('replacement', { expect: replacement.sha256, approval: 'user:replacement accepted' });
  const closed = store.close('one', { expect: rec.sha256, status: 'superseded', evidence: 'user:replace', supersededBy: 'replacement' });
  assert.equal(closed.meta.superseded_by, 'replacement');
  assert.throws(() => store.revise('one', { expect: closed.sha256, source: 'restore', body }), /follow superseded_by/);
  assert.deepEqual(store.list().map(r => r.meta.id), ['replacement']);
});
test('abandonment is a reasoned terminal state; cannot repeatedly close it', t => {
  const { store } = setup(t); const rec = create(store);
  const closed = store.close('one', { expect: rec.sha256, status: 'abandoned', evidence: 'user:cancel' });
  assert.equal(closed.meta.status, 'abandoned');
  assert.throws(() => store.close('one', { expect: closed.sha256, status: 'abandoned', evidence: 'again' }), /already closed/);
});
test('index derives current and history, escapes titles and refuses handwritten replacement', t => {
  const { store } = setup(t); const rec = store.create({ id: 'one', source: 'user:request', body: body.replace('Keep one authority', 'Keep one | authority') });
  store.close('one', { expect: rec.sha256, status: 'abandoned', evidence: 'user:cancel' }); active(store, 'two');
  const index = store.index({ write: true });
  assert.match(index, /Keep one \\\| authority/); assert.match(index, /## History/);
  assert.equal(readFileSync(path.join(store.root, 'INDEX.md'), 'utf8'), index);
  writeFileSync(path.join(store.root, 'INDEX.md'), '# Manual document map');
  assert.throws(() => store.index({ write: true }), /handwritten/);
  assert.equal(readFileSync(path.join(store.root, 'INDEX.md'), 'utf8'), '# Manual document map');
});
test('stale index does not determine listing or active state', t => {
  const { store } = setup(t); active(store); store.index({ write: true }); active(store, 'later');
  assert.equal(store.list().length, 2); assert.doesNotMatch(readFileSync(path.join(store.root, 'INDEX.md'), 'utf8'), /later/);
});
test('an existing lock prevents writes and is never silently deleted', t => {
  const { store } = setup(t); mkdirSync(store.root, { recursive: true });
  const lock = path.join(store.root, '.intent.lock'); mkdirSync(lock);
  assert.throws(() => create(store), /locked/); assert.ok(existsSync(lock));
  assert.ok(!existsSync(store.filename('one')));
});
test('validation failure leaves no lock or partial file', t => {
  const { store } = setup(t);
  assert.throws(() => store.create({ id: 'bad', source: 'user', body: '# Intent: missing sections' }), /nonempty/);
  assert.ok(!existsSync(store.filename('bad'))); assert.ok(!existsSync(path.join(store.root, '.intent.lock')));
  create(store); assert.throws(() => create(store), /already exists/);
  assert.ok(!existsSync(path.join(store.root, '.intent.lock')));
  assert.deepEqual(readdirSync(path.dirname(store.filename('one'))), ['intent.md']);
});
test('traversal, unsafe IDs and symlink homes/records are rejected', t => {
  const { dir, store } = setup(t); const outside = mkdtempSync(path.join(tmpdir(), 'rubato-intent-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const home of ['../elsewhere', '.', '/tmp', 'a//b']) assert.throws(() => new IntentStore(dir, home), /home/);
  for (const id of ['../a', 'a/b', '', '-bad']) assert.throws(() => create(store, id), /id/);
  symlinkSync(outside, path.join(dir, 'linked'));
  assert.throws(() => new IntentStore(dir, 'linked/intent'), /symlink/);
  mkdirSync(store.root); symlinkSync(outside, path.join(store.root, 'one'));
  assert.throws(() => create(store), /symlink/); assert.equal(readdirSync(outside).length, 0);
});
test('dangling links cannot be used for new intent files', t => {
  const { store } = setup(t); mkdirSync(path.join(store.root, 'one'), { recursive: true });
  symlinkSync('/nonexistent-rubato-intent-test-target', path.join(store.root, 'one/intent.md'));
  assert.throws(() => create(store), /symlink/);
});
test('alternate project-relative home is preserved in references', t => {
  const { store } = setup(t, 'docs/intent'); const rec = create(store);
  assert.equal(rec.path, 'docs/intent/one/intent.md');
});
test('invalid or duplicate metadata and body omissions fail closed', t => {
  const { store } = setup(t); create(store); const text = readFileSync(store.filename('one'), 'utf8');
  assert.throws(() => decode(text.replace('schema: 1', 'schema: 1\nschema: 1')), /duplicate/);
  assert.throws(() => decode(text.replace('schema: 1', 'schema: 2')), /unsupported/);
  assert.throws(() => decode(text.replace('status: "draft"', 'status: "unknown"')), /unknown/);
  assert.throws(() => decode(text.replace('## Constraints', '## Something else')), /Constraints/);
});
test('CLI rejects misspellings, duplicate flags and missing values without writing', t => {
  const { dir } = setup(t);
  assert.throws(() => main(['toString', '--workspace', dir]), /unknown command/);
  assert.throws(() => main(['list', '--workspace', dir, '--workspace', dir]), /duplicate/);
  assert.throws(() => main(['list', '--workspace']), /missing value/);
  assert.throws(() => main(['list', '--workspace', dir, '--approve']), /unexpected/);
  assert.deepEqual(readdirSync(dir), []);
});
test('CLI round trip exercises the real executable with JSON output and failure exit codes', t => {
  const { dir } = setup(t); const file = path.join(dir, 'body.md'); writeFileSync(file, body);
  const run = (...args) => spawnSync(process.execPath, [helper, ...args, '--workspace', dir], { encoding: 'utf8' });
  const result = run('create', '--id', 'roundtrip', '--source', 'user:request', '--body', file);
  assert.equal(result.status, 0, result.stderr); const draft = JSON.parse(result.stdout);
  const accepted = run('activate', '--id', 'roundtrip', '--expect', draft.intent_ref.sha256, '--approval', 'user:accept');
  assert.equal(accepted.status, 0, accepted.stderr);
  const ref = JSON.parse(accepted.stdout).intent_ref;
  assert.equal(run('check', '--id', 'roundtrip', '--expect', ref.sha256, '--active').status, 0);
  const stale = run('check', '--id', 'roundtrip', '--expect', draft.intent_ref.sha256, '--active');
  assert.equal(stale.status, 1); assert.match(stale.stderr, /stale/);
});

test('revisions preserve the originating request and record their own reason separately', t => {
  const { store } = setup(t); const rec = active(store);
  const changed = store.revise('one', { expect: rec.sha256, source: 'user:revision-2', body });
  assert.equal(changed.meta.source, 'user:request-1');
  assert.equal(changed.meta.revision_source, 'user:revision-2');
});


test('discovery can inspect an exact draft reference without activating or changing it', t => {
  const { dir, store } = setup(t); const rec = create(store);
  const found = main(['check', '--workspace', dir, '--id', 'one', '--expect', rec.sha256]);
  assert.equal(found.status, 'draft'); assert.equal(found.approval, null);
  assert.equal(store.read('one').sha256, rec.sha256);
  assert.throws(() => main(['check','--workspace',dir,'--id','one','--expect',rec.sha256,'--active']), /not active/);
});

test('one concrete human reply can be recorded as provenance for a corrected intent revision', t => {
  const { store } = setup(t); const first = create(store);
  const reply = 'conversation:proposal-12/reply-13: intent+roster accepted; preserve old accounts';
  const corrected = store.revise('one', { expect: first.sha256, source: reply,
    body: body.replace('preserve the current delivery contract.', 'preserve the current delivery contract and old accounts.') });
  const accepted = store.activate('one', { expect: corrected.sha256, approval: reply });
  assert.equal(accepted.meta.source, first.meta.source);
  assert.equal(accepted.meta.revision_source, reply); assert.equal(accepted.meta.approval, reply);
  assert.equal(accepted.meta.revision, 2);
  assert.equal(store.check('one', { expect: accepted.sha256, active: true }).meta.status, 'active');
  assert.throws(() => store.check('one', { expect: first.sha256, active: true }), /stale/);
});

test('an unchanged active intent can be reused across a new mission without reactivation', t => {
  const { dir, store } = setup(t); const rec = active(store);
  const before = readFileSync(store.filename('one'), 'utf8');
  const resumed = new IntentStore(dir); resumed.check('one', { expect: rec.sha256, active: true });
  assert.equal(readFileSync(store.filename('one'), 'utf8'), before);
  assert.equal(resumed.list().length, 1);
});

test('Korean recommendation content keeps parser compatibility and is protected after acceptance', t => {
  const { store } = setup(t);
  const kr = '# Intent: 문서 기준을 하나로 정하기\n\n## Problem\n같은 내용을 여러 문서가 다르게 설명해.\n\n## Proposed outcome\n어느 문서를 읽어야 하는지 바로 알 수 있게 해.\n\n## Recommended direction and basis\n기존 기준 문서를 고치고 중복 설명은 연결로 바꾸는 걸 추천해.\n\n## Constraints\n사용자 요청: 코드 동작은 그대로 둬.\n\n## Open questions\n승인할 범위를 바꾸는 미해결 질문은 없어.\n';
  const rec = store.create({ id:'korean',source:'user:요청',body:kr });
  const accepted = store.activate('korean',{ expect:rec.sha256,approval:'user:통합제안-확인' });
  assert.equal(store.check('korean',{ active:true }).body,kr);
  writeFileSync(store.filename('korean'),readFileSync(store.filename('korean'),'utf8').replace('연결로 바꾸는','삭제하는'));
  assert.throws(() => store.check('korean',{ active:true }),/approved content changed/);
  assert.ok(accepted.meta.approved_sha256);
});
