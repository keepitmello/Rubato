// Settings layout (intent settings-layout): Settings regrouped by what a person
// comes to change, in four sidebar groups. General had 48 rows of every kind;
// they now sit on Agents, Chat, Threads & Projects, Notifications & Sounds,
// Git & Worktrees and Advanced, and Storage and Phone fold into their neighbours.
//
// T3's panels are not rewritten. Each row and section keeps its code; a Rubato
// page draws T3's panels inside blocks, and a block shows only the rows or
// sections the table places there (settings/rubatoSettingsLayout.ts). The
// edits below are the gate in T3's three settings primitives, the sidebar,
// search and the routes, so an upstream change to a row's wording or behaviour
// arrives untouched. A row T3 adds to General shows under Advanced > Other
// until the table places it; rubatoSettingsLayout.test.ts fails until then.
//
// Providers stays its own page: it edits one environment at a time, while the
// defaults on Agents follow the project and environment scope.
export const settingsLayoutOverlays = [
  'apps/web/src/components/settings/rubatoSettingsLayout.ts',
  'apps/web/src/components/settings/rubatoSettingsLayout.test.ts',
  'apps/web/src/components/settings/rubatoSettingsBlock.tsx',
  'apps/web/src/components/settings/RubatoSettingsPage.tsx',
  'apps/web/src/routes/settings.notifications.tsx',
  'apps/web/src/routes/settings.agents.tsx',
  'apps/web/src/routes/settings.chat.tsx',
  'apps/web/src/routes/settings.threads.tsx',
  'apps/web/src/routes/settings.advanced.tsx',
];

/** Route slugs the generated route tree gains (route-tree-edits.mjs). */
export const settingsLayoutPages = ['notifications', 'agents', 'chat', 'threads', 'advanced'];

const rubatoRoute = (slug, name) => [
  'import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";\n',
  '\n',
  "// Rubato's Settings layout (settings-layout-edits.mjs).\n",
  `function ${name}() {\n`,
  `  return <RubatoSettingsPage path="/settings/${slug}" />;\n`,
  '}\n',
].join('');

export const settingsLayoutEdits = {
  'apps/web/src/components/settings/settingsLayout.tsx': [
    ['import { SettingsGroup } from "./SettingsGroup";\n',
      'import {\n'
        + '  RubatoSettingsRowGate,\n'
        + '  RubatoSettingsSectionGate,\n'
        + '  useRubatoNestedSettingsPage,\n'
        + '} from "./rubatoSettingsBlock";\n'],
    ['/** Muted section headings have no descriptions; explanatory copy belongs to individual settings. */\n'
      + 'export function SettingsSection({\n',
      '/** Muted section headings have no descriptions; explanatory copy belongs to individual settings. */\n'
        + 'export function SettingsSection(props: Parameters<typeof SettingsSectionBody>[0]) {\n'
        + '  // Rubato: on a Rubato settings page the block decides whether it shows (settings-layout-edits.mjs).\n'
        + '  return (\n'
        + '    <RubatoSettingsSectionGate id={props.id} section={() => <SettingsSectionBody {...props} />}>\n'
        + '      {props.children}\n'
        + '    </RubatoSettingsSectionGate>\n'
        + '  );\n'
        + '}\n'
        + '\n'
        + 'function SettingsSectionBody({\n',
      'replace'],
    ['export function SettingsRow({\n  title,\n  description,\n',
      'export function SettingsRow(props: Parameters<typeof SettingsRowBody>[0]) {\n'
        + '  // Rubato: on a Rubato settings page the block decides whether it shows (settings-layout-edits.mjs).\n'
        + '  return (\n'
        + '    <RubatoSettingsRowGate id={props.id} settingKeys={props.settingKeys}>\n'
        + '      <SettingsRowBody {...props} />\n'
        + '    </RubatoSettingsRowGate>\n'
        + '  );\n'
        + '}\n'
        + '\n'
        + 'function SettingsRowBody({\n  title,\n  description,\n',
      'replace'],
    ['export function SettingsPageContainer({\n  children,\n  className,\n  width = "readable",\n}: {\n',
      'export function SettingsPageContainer(props: Parameters<typeof SettingsPageContainerBody>[0]) {\n'
        + '  // Rubato: a T3 page drawn inside a Rubato settings page keeps only its content.\n'
        + '  const nested = useRubatoNestedSettingsPage();\n'
        + '  return nested ? props.children : <SettingsPageContainerBody {...props} />;\n'
        + '}\n'
        + '\n'
        + 'function SettingsPageContainerBody({\n  children,\n  className,\n  width = "readable",\n}: {\n',
      'replace'],
  ],
  // General's Legacy features fold is a <section> of its own, not a SettingsSection.
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { SettingsGroup } from "./SettingsGroup";\n',
      'import { useRubatoHidesSection } from "./rubatoSettingsBlock";\n'],
    ['  }, [searchTargetId]);\n\n  return (\n    <section id="legacy-features"',
      '  }, [searchTargetId]);\n'
        + '  // Rubato: shown on a Rubato settings page only by the block that names it (settings-layout-edits.mjs).\n'
        + '  const rubatoHidden = useRubatoHidesSection("legacy-features");\n'
        + '  if (rubatoHidden) return null;\n'
        + '\n  return (\n    <section id="legacy-features"',
      'replace'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/storage"\n',
      '  | "/settings/notifications"\n  | "/settings/agents"\n  | "/settings/chat"\n  | "/settings/threads"\n  | "/settings/advanced"\n'],
    ['  "/settings/integrations": "Integrations",\n', '  "/settings/integrations": "Browser & Devices",\n', 'replace'],
    ['  "/settings/source-control": "Source Control",\n', '  "/settings/source-control": "Git & Worktrees",\n', 'replace'],
    ['  "/settings/storage": "Storage",\n',
      '  "/settings/notifications": "Notifications & Sounds",\n'
        + '  "/settings/agents": "Agents",\n'
        + '  "/settings/chat": "Chat",\n'
        + '  "/settings/threads": "Threads & Projects",\n'
        + '  "/settings/advanced": "Advanced",\n'],
    ['  "/settings/storage": "project-defaults",\n',
      '  "/settings/notifications": null,\n'
        + '  "/settings/agents": null,\n'
        + '  "/settings/chat": null,\n'
        + '  "/settings/threads": null,\n'
        + '  "/settings/advanced": null,\n'],
  ],
  // The sidebar and the command palette both search through this hook.
  'apps/web/src/components/settings/useAvailableSettingsSearchItems.ts': [
    ['import type { SettingsScopeSearch } from "./settingsScope";\n',
      'import { rubatoSearchItems } from "./rubatoSettingsLayout";\n'],
    ['    () =>\n      filterAvailableSettingsSearchItems({\n',
      '    () =>\n'
        + "      // Rubato: results open the page Rubato's layout puts the setting on (settings-layout-edits.mjs).\n"
        + '      rubatoSearchItems(filterAvailableSettingsSearchItems({\n',
      'replace'],
    ['        managedTunnelActive,\n      }),\n    [\n',
      '        managedTunnelActive,\n      })),\n    [\n',
      'replace'],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['import {\n  lazy,\n', 'import { Fragment as RubatoFragment } from "react";\n'],
    ['  SearchIcon,\n', '  BellIcon,\n  ListTreeIcon,\n  MessageSquareIcon,\n  SparklesIcon,\n  WrenchIcon,\n'],
    ['  "/settings/archived": ArchiveIcon,\n',
      '  "/settings/notifications": BellIcon,\n'
        + '  "/settings/agents": SparklesIcon,\n'
        + '  "/settings/chat": MessageSquareIcon,\n'
        + '  "/settings/threads": ListTreeIcon,\n'
        + '  "/settings/advanced": WrenchIcon,\n'],
    ['function SettingsSectionIcon({ to }: { to: SettingsPath }) {\n',
      [
        "// Rubato: the sidebar follows Rubato's Settings layout, in groups (settings-layout-edits.mjs).",
        'const RUBATO_SETTINGS_NAV_ITEMS: ReadonlyArray<{',
        '  label: string;',
        '  to: SettingsPath;',
        '  icon: ComponentType<{ className?: string }>;',
        '  group: string | null;',
        '}> = [',
        '  {',
        '    to: "/settings/projects",',
        '    label: SETTINGS_SECTION_LABELS["/settings/projects"],',
        '    icon: SETTINGS_SECTION_ICONS["/settings/projects"],',
        '    group: null,',
        '  },',
        '  ...RUBATO_SETTINGS_PAGES.map((page, index) => ({',
        '    to: page.path,',
        '    label: page.label,',
        '    icon: SETTINGS_SECTION_ICONS[page.path],',
        '    group: RUBATO_SETTINGS_PAGES[index - 1]?.group === page.group ? null : page.group,',
        '  })),',
        '];',
        '',
        '',
      ].join('\n')],
    ['import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";\n',
      'import { RUBATO_SETTINGS_DETAIL_PAGES, RUBATO_SETTINGS_PAGES } from "./rubatoSettingsLayout";\n'],
    ['  const navItems = SETTINGS_NAV_ITEMS.filter(\n', '  const navItems = RUBATO_SETTINGS_NAV_ITEMS.filter(\n', 'replace'],
    ['                  const isGeneralDetailPage =\n'
      + '                    item.to === "/settings/general" &&\n'
      + '                    pathname === "/settings/open-source-licenses";\n',
      '                  const isGeneralDetailPage = RUBATO_SETTINGS_DETAIL_PAGES[pathname] === item.to;\n',
      'replace'],
    ['                  return (\n                    <SidebarMenuItem key={item.to}>\n',
      '                  return (\n'
        + '                    <RubatoFragment key={item.to}>\n'
        + '                    {item.group ? (\n'
        + '                      <li className="px-2 pt-4 pb-1 text-2xs font-medium uppercase tracking-wide text-sidebar-muted-foreground/60 first:pt-1">\n'
        + '                        {item.group}\n'
        + '                      </li>\n'
        + '                    ) : null}\n'
        + '                    <SidebarMenuItem>\n',
      'replace'],
    ['                    </SidebarMenuItem>\n                  );\n                })}\n',
      '                    </SidebarMenuItem>\n                    </RubatoFragment>\n                  );\n                })}\n',
      'replace'],
  ],
  'apps/web/src/routes/settings.general.tsx': [
    ['import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";\n',
      'import { RubatoSettingsPage } from "../components/settings/RubatoSettingsPage";\n', 'replace'],
    ['  return <GeneralSettingsPanel />;\n', '  return <RubatoSettingsPage path="/settings/general" />;\n', 'replace'],
  ],
  'apps/web/src/routes/settings.source-control.tsx': [
    ['import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";\n',
      rubatoRoute('source-control', 'SettingsSourceControlRoute'), 'replace'],
    ['  component: SourceControlSettingsPanel,\n', '  component: SettingsSourceControlRoute,\n', 'replace'],
  ],
  'apps/web/src/routes/settings.integrations.tsx': [
    ['import { IntegrationsSettingsPanel } from "../components/settings/IntegrationsSettings";\n',
      rubatoRoute('integrations', 'SettingsIntegrationsRoute'), 'replace'],
    ['  component: IntegrationsSettingsPanel,\n', '  component: SettingsIntegrationsRoute,\n', 'replace'],
  ],
  'apps/web/src/routes/settings.connections.tsx': [
    ['import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";\n',
      rubatoRoute('connections', 'SettingsConnectionsRoute'), 'replace'],
    ['  component: ConnectionsSettings,\n', '  component: SettingsConnectionsRoute,\n', 'replace'],
  ],
  // Storage is split between Git & Worktrees and Advanced; its old address opens Advanced.
  'apps/web/src/routes/settings.storage.tsx': [
    ['import { createFileRoute } from "@tanstack/react-router";\nimport { StorageSettingsPanel } from "../components/settings/StorageSettings";\n',
      'import { createFileRoute, redirect } from "@tanstack/react-router";\n', 'replace'],
    ['({ component: StorageSettingsPanel });\n',
      '({\n'
        + "  // Rubato: Storage is split between Git & Worktrees and Advanced (settings-layout-edits.mjs).\n"
        + '  beforeLoad: () => {\n'
        + '    throw redirect({ to: "/settings/advanced", replace: true });\n'
        + '  },\n'
        + '});\n',
      'replace'],
  ],
};
