// 레거시 사이드바의 프로젝트 밑 스레드 목록에 세로선을 다시 지운다.
//
// 그 선은 T3 의 SidebarMenuSub (ui/sidebar.tsx) 가 기본으로 두는 `border-l` 이다.
// 업스트림은 2026-09-22 f46522777 "app code stops restyling sidebar, popover, table
// and misc ui exports" (#13207) 에서 호출부의 클래스 중 "기본값을 되풀이하는 것"을
// 걷어냈는데, LegacySidebar 가 스레드 목록에 붙여 둔 `border-l-0` 도 그때 함께
// 지워졌다. 그건 되풀이가 아니라 기본값을 끄는 것이었으므로 선이 되살아났다.
// 이 핀 이전(c14f6015b)에는 `border-l-0` 이 있어서 선이 없었다.
//
// 되돌리는 것은 그 한 토큰뿐이다. 같은 커밋이 지운 `gap-0.5 px-1 py-0` 은
// 업스트림이 일부러 고른 인셋이라 손대지 않는다. 새 사이드바(Sidebar.tsx)는
// SidebarMenuSub 을 쓰지 않으므로 이 수정은 Rubato 가 켜 둔 레거시 사이드바에만
// 닿는다.
export const sidebarRailOverlays = [];

export const sidebarRailEdits = {
  'apps/web/src/components/LegacySidebar.tsx': [
    [
      '      className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden sm:mx-1"\n',
      '      className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden border-l-0 sm:mx-1"\n',
      'replace',
    ],
  ],
};
