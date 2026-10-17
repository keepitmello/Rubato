import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// 오른쪽 패널 너비는 앱 전체에 하나다 (right-panel-edits.mjs). 업스트림은 스레드마다
// 따로 저장해서 새 스레드·다른 프로젝트마다 기본 너비로 다시 열렸다. 채팅 화면이 넘기는
// 저장 키가 스레드에 따라 바뀌면 그 문제가 돌아온다.
test('the right panel opens at one remembered width in every thread', { skip: !process.env.T3_SOURCE }, async () => {
  const read = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');
  const chat = await read('apps/web/src/components/ChatView.tsx');
  const start = chat.indexOf('usePreviewPanelInlineSize(undefined, {');
  assert.notEqual(start, -1, '채팅 화면이 오른쪽 패널 너비를 잡는 자리를 찾지 못했다');
  const call = chat.slice(start, chat.indexOf('});', start));
  const key = call.match(/widthStorageKey:\s*(.+),/);
  assert.ok(key, '저장 키를 넘기지 않는다');
  assert.match(key[1], /^"[^"]+"$/, `저장 키가 고정 문자열이 아니다: ${key[1]}`);

  // 처음 드래그하기 전의 너비는 업스트림 기본값 그대로 둔다.
  assert.doesNotMatch(call, /defaultWidth/, '채팅 화면이 기본 너비를 덮어쓴다');
});
