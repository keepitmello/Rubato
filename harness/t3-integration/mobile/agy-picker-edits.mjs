// The phone's thread settings list each Antigravity login once, as the desktop's picker does
// (user, session 01a21452: "메인 서브 헬레나가 따로 떠 / 루바토/헬레나를 메인 서브 바꿔 골라야하는데").
// One T3 instance pairs one agy agent with one Google login, so the sheet showed "Antigravity",
// "Antigravity [sub]" and a "헬레나" section per login. Now a login is one section named for it, with
// its agents (Rubato, 헬레나) as a choice above the models; search and the favorites filter keep
// every agent's models, each under "login · agent" (rubatoAgyLoginGroups.ts). The provider filter
// menu lists the logins the same way, since it reads the same groups.
//
// Cost per upstream bump: 9 anchors in 1 file, all here.
export const mobileAgyPickerOverlays = [
  'apps/mobile/src/features/threads/rubatoAgyLoginGroups.ts',
  'apps/mobile/src/features/threads/rubatoAgyLoginGroups.test.ts',
];

const sheet = 'apps/mobile/src/features/threads/ThreadSettingsSheet.tsx';

export const mobileAgyPickerEdits = {
  [sheet]: [
    ['import { ModelRow, ChoiceRow } from "./ThreadSettingsRows";\n',
      'import { agyLoginGroups, type AgyLoginChoice } from "./rubatoAgyLoginGroups";\n'],
    ['  readonly toggleProvider: (providerKey: string) => void;\n',
      '  readonly toggleProvider: (providerKey: string) => void;\n' +
      '  readonly agyChoices: ReadonlyMap<string, AgyLoginChoice>;\n' +
      '  readonly pickAgyAgent: (railId: string, instanceId: string) => void;\n',
      'replace'],
    ['  const [searchQuery, setSearchQuery] = useState("");\n',
      '  const [searchQuery, setSearchQuery] = useState("");\n' +
      '  const [agyPicked, setAgyPicked] = useState<ReadonlyMap<string, string>>(() => new Map());\n',
      'replace'],
    ['  const value = {\n    environmentId,\n    providerInstanceId: props.providerInstanceId,\n    providerGroups,\n',
      [
        '  // Rubato: one section per Antigravity login, its agents a choice above the models.',
        '  const agyLogins = agyLoginGroups({',
        '    groups: providerGroups,',
        '    instances: settings?.providerInstances,',
        '    picked: agyPicked,',
        '    displayedInstanceId: (pendingModel?.selection ?? props.selectedModel)?.instanceId,',
        '    narrowed: searchQuery.trim().length > 0 || providerFilter === FAVORITES_PROVIDER_FILTER,',
        '  });',
        '  const pickAgyAgent = (railId: string, instanceId: string) => {',
        '    void Haptics.selectionAsync();',
        '    setAgyPicked((current) => new Map(current).set(railId, instanceId));',
        '  };',
        '',
        '  const value = {',
        '    environmentId,',
        '    providerInstanceId: props.providerInstanceId,',
        '    providerGroups: agyLogins.groups,',
        '    agyChoices: agyLogins.choices,',
        '    pickAgyAgent,',
        '',
      ].join('\n'),
      'replace'],
    ['  | {\n      readonly kind: "notice";\n',
      '  | {\n' +
      '      readonly kind: "agyAgents";\n' +
      '      readonly key: string;\n' +
      '      readonly railId: string;\n' +
      '      readonly choice: AgyLoginChoice;\n' +
      '    }\n'],
    ['const modelItems = (models: ReadonlyArray<ModelOption>) =>\n',
      [
        '/** Rubato: the agents on one Antigravity login, as the desktop picker\'s choice above its models. */',
        'function ThreadSettingsAgyAgentChoice(props: {',
        '  readonly item: Extract<ThreadSettingsCatalogItem, { kind: "agyAgents" }>;',
        '}) {',
        '  const session = useThreadSettingsSession();',
        '  return (',
        '    <View accessibilityRole="radiogroup" className="mx-4 mb-2 flex-row flex-wrap gap-2 px-1">',
        '      {props.item.choice.agents.map((agent) => {',
        '        const checked = agent.instanceId === props.item.choice.chosen;',
        '        return (',
        '          <Pressable',
        '            key={agent.instanceId}',
        '            accessibilityRole="radio"',
        '            accessibilityState={{ checked }}',
        '            accessibilityLabel={agent.label}',
        '            onPress={() => session.pickAgyAgent(props.item.railId, agent.instanceId)}',
        '            className={cn(',
        '              "justify-center rounded-full px-4 active:opacity-60",',
        '              checked ? "bg-grouped-card" : "border border-border-subtle",',
        '            )}',
        '            style={{ minHeight: 34 }}',
        '          >',
        '            <Text',
        '              className={cn(',
        '                "text-sm",',
        '                checked ? "font-t3-medium text-foreground" : "text-foreground-muted",',
        '              )}',
        '            >',
        '              {agent.label}',
        '            </Text>',
        '          </Pressable>',
        '        );',
        '      })}',
        '    </View>',
        '  );',
        '}',
        '',
        '',
      ].join('\n')],
    ['      {\n        kind: "provider" as const,\n        key: `provider:${group.providerKey}`,\n        provider,\n      },\n',
      '      {\n        kind: "provider" as const,\n        key: `provider:${group.providerKey}`,\n        provider,\n      },\n' +
      '      ...(collapsed || (session.agyChoices.get(group.providerKey)?.agents.length ?? 0) < 2\n' +
      '        ? []\n' +
      '        : [\n' +
      '            {\n' +
      '              kind: "agyAgents" as const,\n' +
      '              key: `agy-agents:${group.providerKey}`,\n' +
      '              railId: group.providerKey,\n' +
      '              choice: session.agyChoices.get(group.providerKey)!,\n' +
      '            },\n' +
      '          ]),\n',
      'replace'],
    ['    } else if (item.kind === "notice") {\n',
      '    } else if (item.kind === "agyAgents") {\n      content = <ThreadSettingsAgyAgentChoice item={item} />;\n'],
  ],
};
