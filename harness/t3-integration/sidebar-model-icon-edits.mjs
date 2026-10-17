// 스레드가 쓰는 모델을 보여주는 곳의 작은 아이콘 (새 사이드바 카드, 카드 호버 툴팁,
// 명령 팔레트의 스레드 검색 결과). T3 는 스레드가 쓰는 제공자
// 인스턴스의 아이콘을 그리는데, Rubato 한 인스턴스에는 여러 회사의 모델이 실려 있어서
// 모든 Rubato 스레드가 앱 로고로 보였다. 모델 선택기와 같은 매핑(rubatoModelIcons)으로
// 스레드가 쓰는 모델의 회사 로고를 그린다. 모델을 모르면 기존 인스턴스 아이콘 그대로다.
export const sidebarModelIconOverlays = [
  'apps/web/src/components/sidebar/rubatoThreadModelIcon.ts',
  'apps/web/src/components/sidebar/rubatoThreadModelIcon.test.ts',
];

// 원본 해시는 upstream.json targets 에 있다.

export const sidebarModelIconEdits = {
  'apps/web/src/components/Sidebar.tsx': [
    ['import { forkThread, threadRunsOnRubato } from "./sidebar/rubatoThreadFork";\n',
      'import { threadModelIcon } from "./sidebar/rubatoThreadModelIcon";\n'],
    [
      '  const current = (\n    <ProviderInstanceIcon\n      driverKind={currentEntry.driverKind}',
      '  const ModelIcon = threadModelIcon(currentEntry.driverKind, props.thread.modelSelection.model);\n  const current = ModelIcon ? (\n    <ModelIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />\n  ) : (\n    <ProviderInstanceIcon\n      driverKind={currentEntry.driverKind}',
      'replace',
    ],
    ['  const driverKind = providerEntry?.driverKind ?? null;\n',
      '  const driverKind = providerEntry?.driverKind ?? null;\n  const TooltipModelIcon = threadModelIcon(driverKind, thread.modelSelection.model);\n',
      'replace'],
    [
      '            <ProviderInstanceIcon\n              driverKind={driverKind}\n',
      '            {TooltipModelIcon ? (\n              <TooltipModelIcon className="size-3 shrink-0 opacity-60" aria-hidden />\n            ) : (\n            <ProviderInstanceIcon\n              driverKind={driverKind}\n',
      'replace',
    ],
    [
      '              iconClassName="size-3 shrink-0 grayscale opacity-60"\n            />\n            <div className="min-w-0 truncate text-foreground/75">\n              {showInstanceBadge && providerEntry',
      '              iconClassName="size-3 shrink-0 grayscale opacity-60"\n            />\n            )}\n            <div className="min-w-0 truncate text-foreground/75">\n              {showInstanceBadge && providerEntry',
      'replace',
    ],
  ],
  'apps/web/src/components/ThreadCommandSubtitle.tsx': [
    ['import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";\n',
      'import { threadModelIcon } from "./sidebar/rubatoThreadModelIcon";\n'],
    ['  driverKind?: ProviderDriverKind | null;\n',
      '  /** The thread\'s model slug; a Rubato thread shows its company glyph (rubatoThreadModelIcon.ts). */\n  model?: string | undefined;\n'],
    ['          <ProviderInstanceIcon\n            driverKind={props.driverKind}',
      '          {ModelIcon ? (\n            <ModelIcon className="size-3 shrink-0 opacity-70" aria-hidden />\n          ) : (\n          <ProviderInstanceIcon\n            driverKind={props.driverKind}',
      'replace'],
    ['            iconClassName="size-3 shrink-0 opacity-70"\n          />\n',
      '            iconClassName="size-3 shrink-0 opacity-70"\n          />\n          )}\n',
      'replace'],
    ['  const projectLabel = props.projectTitle?.trim() || null;\n',
      '  const ModelIcon =\n    props.driverKind != null && props.model ? threadModelIcon(props.driverKind, props.model) : null;\n'],
  ],
  'apps/web/src/components/CommandPalette.tsx': [
    ['              driverKind={providerEntry?.driverKind ?? null}\n',
      '              model={thread.modelSelection.model}\n'],
  ],
};
