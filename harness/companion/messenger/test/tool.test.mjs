import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sendTelegram, TELEGRAM_SEND_TOOL } from '../../../pi-runtime/features/companion-messenger/index.mjs';
import { listOutbox } from '../store.mjs';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-messenger-tool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { RUBATO_COMPANION_HOME: path.join(dir, 'companion') };
}

test('the companion tool only queues: the person gets it, anyone else waits for approval', (t) => {
  const env = sandbox(t);
  const toUser = sendTelegram({ text: '보고드릴 게 있어요.' }, env);
  assert.equal(toUser.target, 'user');
  assert.equal(toUser.state, 'queued');

  const toOther = sendTelegram({ text: '재현 경로를 알려주세요.', to: '-100123', name: '버그 리포트' }, env);
  assert.deepEqual(toOther.target, { chatId: '-100123', name: '버그 리포트' });
  assert.equal(toOther.state, 'queued', 'the tool holds nothing itself; the service holds it before sending');

  const rows = listOutbox(env);
  assert.equal(rows.length, 2);
  assert.equal(typeof TELEGRAM_SEND_TOOL, 'string');
});

test('the tool refuses an empty message', (t) => {
  const env = sandbox(t);
  assert.throws(() => sendTelegram({ text: '   ' }, env), /non-empty/);
});

