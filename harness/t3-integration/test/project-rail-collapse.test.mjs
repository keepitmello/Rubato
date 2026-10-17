import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// 프로젝트 레일 옆 사이드바는 레일 폭만큼 오른쪽에서 시작한다 (project-rail-edits.mjs).
// 접힐 때도 그 폭을 빼고 멈추면 사이드바 끝 52px 가 레일 뒤에 남고, 반투명 창에서는
// 스레드 목록의 시간·아이콘이 레일 버튼 위로 비친다. 접힌 사이드바는 화면 밖에 통째로
// 있어야 한다.
test('the collapsed sidebar leaves nothing behind the project rail', { skip: !process.env.T3_SOURCE }, async () => {
  const sidebar = await readFile(
    path.join(process.env.T3_SOURCE, 'apps/web/src/components/ui/sidebar.tsx'),
    'utf8',
  );
  const line = sidebar.split('\n').find((text) => text.includes('left-[var(--sidebar-offset-left,0px)]'));
  assert.ok(line, '펼친 사이드바가 레일 폭만큼 밀려 시작하지 않는다');
  const collapsed = line.match(/group-data-\[collapsible=offcanvas\]:left-\[([^\]]+)\]/);
  assert.ok(collapsed, '접힌 사이드바의 위치가 없다');
  assert.equal(collapsed[1], 'calc(var(--sidebar-width)*-1)', '접힌 사이드바가 화면 밖으로 다 나가지 않는다');
});
