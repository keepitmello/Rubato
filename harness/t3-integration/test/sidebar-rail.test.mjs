import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// 프로젝트를 펼치면 그 밑 스레드 목록 왼쪽에 세로선이 하나 그어진다. 그건 T3 의
// SidebarMenuSub 이 기본으로 두는 `border-l` 이고, LegacySidebar 는 스레드 목록에서
// 그것을 `border-l-0` 으로 끈다 (sidebar-rail-edits.mjs). 업스트림 리팩터가 이
// override 를 "기본값을 되풀이하는 것"으로 보고 지운 적이 있어서, 그 자리가 다시
// 비면 선이 되살아난다.
test('the legacy sidebar thread list draws no rail', { skip: !process.env.T3_SOURCE }, async () => {
  const source = process.env.T3_SOURCE;
  const read = (relative) => readFile(path.join(source, relative), 'utf8');
  const between = (text, from, to) => {
    const start = text.indexOf(from);
    assert.notEqual(start, -1, `찾지 못했다: ${from}`);
    const end = text.indexOf(to, start);
    assert.notEqual(end, -1, `찾지 못했다: ${to}`);
    return text.slice(start, end);
  };

  // 기준: 기본 클래스가 정말 선을 그리는가. 업스트림이 선을 없애면 우리 override 는
  // 할 일이 없어지므로, 그때는 이 시험이 먼저 말해 준다.
  const primitive = await read('apps/web/src/components/ui/sidebar.tsx');
  const base = between(primitive, 'function SidebarMenuSub(', 'data-sidebar="menu-sub"');
  assert.match(base, /[\s"]border-l[\s"]/, '기본 클래스가 더는 선을 그리지 않는다');

  // 스레드 목록도 같은 기본 클래스를 쓰므로, 그 자리가 선을 꺼야 한다.
  const legacy = await read('apps/web/src/components/LegacySidebar.tsx');
  const threadList = between(legacy, 'ref={attachThreadListAutoAnimateRef}', '>');
  assert.match(threadList, /className="[^"]*[\s]border-l-0[\s"]/, '스레드 목록이 기본 선을 끄지 않는다');
});
