// 새 사이드바 스레드 카드 오른쪽 아래의 작은 아이콘. T3 는 스레드가 쓰는 제공자
// 인스턴스의 아이콘을 그리는데, Rubato 한 인스턴스에는 여러 회사의 모델이 실려 있어서
// 모든 Rubato 스레드가 앱 로고로 보였다. 모델 선택기와 같은 매핑(rubatoModelIcons)으로
// 스레드가 쓰는 모델의 회사 로고를 그린다. 모델을 모르면 기존 인스턴스 아이콘 그대로다.
export const sidebarModelIconOverlays = [
  'apps/web/src/components/sidebar/rubatoThreadModelIcon.ts',
  'apps/web/src/components/sidebar/rubatoThreadModelIcon.test.ts',
];

export const sidebarModelIconEdits = {
  'apps/web/src/components/Sidebar.tsx': [
    ['import { forkThread, threadRunsOnRubato } from "./sidebar/rubatoThreadFork";\n',
      'import { threadModelIcon } from "./sidebar/rubatoThreadModelIcon";\n'],
    [
      '  const current = (\n    <ProviderInstanceIcon\n      driverKind={currentEntry.driverKind}',
      '  const ModelIcon = threadModelIcon(currentEntry.driverKind, props.thread.modelSelection.model);\n  const current = ModelIcon ? (\n    <ModelIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />\n  ) : (\n    <ProviderInstanceIcon\n      driverKind={currentEntry.driverKind}',
      'replace',
    ],
  ],
};
