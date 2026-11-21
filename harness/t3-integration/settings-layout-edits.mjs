// Settings: T3's pages in T3's groups, with Rubato's pages and sections placed
// among them. T3 v0.1.11 split General into pages of its own (Chat, Threads,
// Voice, Worktrees, Maintenance, About…), so Rubato no longer regroups T3's rows;
// it adds to T3's pages instead.
//
// Rubato's pages sit in T3's sidebar groups: Companion under Agents and Phone
// under Connections (Stats, which opens the rail's page, is stats-edits.mjs's).
// macOS permissions has no sidebar entry; General links to it and the sidebar
// marks General while it is open. Each page's route lives with its module
// (companion-, phone-, permission-, stats-edits.mjs); the route tree is
// route-tree-edits.mjs.
//
// Rubato's sections on T3's pages:
// - General > Sidebar: how many threads Recent shows, and the sidebar's section
//   order (RubatoSidebarSectionsSetting.tsx, sidebar-blocks-edits.mjs).
// - General, last: the link to macOS permissions (RubatoPermissionsLink.tsx).
// - Threads, last: the models that write session titles and summaries
//   (RubatoTitleModels.tsx), beside T3's own text generation.
// - Voice, last: the composer microphone's key and model (RubatoVoiceSettings.tsx).
// - Projects before a project is chosen: the project list and the new-thread
//   screen's project row (project-order-edits.mjs).
// - About: Rubato's section (about-edits.mjs) stands in for T3's version and
//   updater rows, which report T3's releases rather than the Rubato checkout.
//
// Rows for what Rubato does not run (T3's commit/PR/review-guide writer, its
// project sort select, its CLI command row) show nowhere, and search sends a
// result to where Rubato keeps that setting (settings/rubatoSettingsSurface.ts).
export const settingsLayoutOverlays = [
  'apps/web/src/components/settings/rubatoSettingsSurface.ts',
  'apps/web/src/components/settings/rubatoSettingsSurface.test.ts',
  'apps/web/src/components/settings/RubatoPermissionsLink.tsx',
];

const HIDDEN_GATE = "  // Rubato: rows and sections for what Rubato does not run show nowhere (settings-layout-edits.mjs).\n";

export const settingsLayoutEdits = {
  'apps/web/src/components/settings/settingsLayout.tsx': [
    ['import { SettingsGroup } from "./SettingsGroup";\n',
      'import { RUBATO_HIDDEN_SETTINGS } from "./rubatoSettingsSurface";\n'],
    ['export function SettingsSection({\n  title,\n  hideTitle = false,\n',
      'export function SettingsSection(props: Parameters<typeof SettingsSectionBody>[0]) {\n'
        + HIDDEN_GATE
        + '  if (props.id !== undefined && RUBATO_HIDDEN_SETTINGS.has(props.id)) return null;\n'
        + '  return <SettingsSectionBody {...props} />;\n'
        + '}\n'
        + '\n'
        + 'function SettingsSectionBody({\n  title,\n  hideTitle = false,\n',
      'replace'],
    ['export function SettingsRow({\n  title,\n  description,\n',
      'export function SettingsRow(props: Parameters<typeof SettingsRowBody>[0]) {\n'
        + HIDDEN_GATE
        + '  if (props.id !== undefined && RUBATO_HIDDEN_SETTINGS.has(props.id)) return null;\n'
        + '  return <SettingsRowBody {...props} />;\n'
        + '}\n'
        + '\n'
        + 'function SettingsRowBody({\n  title,\n  description,\n',
      'replace'],
  ],
  // The sidebar and the command palette both search through this hook.
  'apps/web/src/components/settings/useAvailableSettingsSearchItems.ts': [
    ['} from "./settingsSearch";\n',
      '} from "./settingsSearch";\nimport { rubatoSettingsSearchItems } from "./rubatoSettingsSurface";\n',
      'replace'],
    ['  return filterAvailableSettingsSearchItems({\n',
      '  // Rubato: without the rows Rubato hides, and sent to where Rubato keeps a setting (settings-layout-edits.mjs).\n'
        + '  return rubatoSettingsSearchItems(filterAvailableSettingsSearchItems({\n',
      'replace'],
    ['    hasPrimaryEnvironment: primaryEnvironmentId !== null,\n  });\n}\n',
      '    hasPrimaryEnvironment: primaryEnvironmentId !== null,\n  }));\n}\n',
      'replace'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    // Rubato's own rows take their id and title from here too.
    ['function searchableSetting(id: SettingsSearchItemId): {\n',
      '// Rubato: Rubato\'s rows read their id and title here as well (settings-layout-edits.mjs).\n'
        + 'export function searchableSetting(id: SettingsSearchItemId): {\n',
      'replace'],
    ['      "/settings/providers",\n      "/settings/threads",\n',
      '      "/settings/companion",\n      "/settings/providers",\n      "/settings/threads",\n',
      'replace'],
    ['      "/settings/connections",\n      "/settings/access",\n',
      '      "/settings/connections",\n      "/settings/phone",\n      "/settings/access",\n',
      'replace'],
    // Rubato's title models, at the end of Threads (settings/RubatoTitleModels.tsx).
    ['  {\n    id: "project-grouping",\n',
      [
        '  {',
        '    id: "rubato-title-models",',
        '    title: "Titles and summaries",',
        '    to: "/settings/threads",',
        '    searchTerms: ["session title model fallback summary stats longest think text generation 제목 요약 모델 language 언어"],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";\n',
      'import { rubatoProjectListSearch } from "./RubatoProjectListSettings";\n'
        + 'import { rubatoOpensProjectList } from "./rubatoSettingsSurface";\n'],
    ['  "/settings/open-source-licenses": "/settings/about",\n',
      '  "/settings/open-source-licenses": "/settings/about",\n'
        + '  // Rubato: General links to macOS permissions (settings-layout-edits.mjs).\n'
        + '  "/settings/permissions": "/settings/general",\n',
      'replace'],
    ['    void navigate({\n      to,\n      hash: "",\n      replace: true,\n      hashScrollIntoView: false,\n    });\n',
      '    void navigate({\n'
        + '      to,\n'
        + '      hash: "",\n'
        + '      replace: true,\n'
        + '      hashScrollIntoView: false,\n'
        + '      // Rubato: Projects opens the project list (settings-layout-edits.mjs).\n'
        + '      ...(to === "/settings/projects" ? { search: rubatoProjectListSearch } : {}),\n'
        + '    });\n',
      'replace'],
    ['      hashScrollIntoView: false,\n      state: { settingsTargetHighlight: true },\n    });\n',
      '      hashScrollIntoView: false,\n'
        + '      state: { settingsTargetHighlight: true },\n'
        + '      // Rubato: a result on the project list lands on the list (settings-layout-edits.mjs).\n'
        + '      ...(rubatoOpensProjectList(item) ? { search: rubatoProjectListSearch } : {}),\n'
        + '    });\n',
      'replace'],
  ],
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { CliCommandSettingsRow } from "./CliCommandSettingsRow";\n',
      'import { RubatoPermissionsLinkSection } from "./RubatoPermissionsLink";\n'
        + 'import { RubatoSidebarSectionsSettingsRows } from "./RubatoSidebarSectionsSetting";\n'
        + 'import { RubatoTitleModelsSection } from "./RubatoTitleModels";\n'],
    // General > Sidebar.
    ['              aria-label={gt("Working section")}\n            />\n          }\n        />\n      </SettingsSection>\n',
      '              aria-label={gt("Working section")}\n            />\n          }\n        />\n'
        + '        {/* Rubato: Recent\'s length and the section order (settings-layout-edits.mjs). */}\n'
        + '        <RubatoSidebarSectionsSettingsRows />\n'
        + '      </SettingsSection>\n',
      'replace'],
    // General, last.
    ['    </SettingsPageContainer>\n  );\n}\n\nexport function ChatSettingsPanel() {\n',
      '      {/* Rubato: macOS permissions (settings-layout-edits.mjs). */}\n'
        + '      <RubatoPermissionsLinkSection />\n'],
    // Threads, last.
    ['    </SettingsPageContainer>\n  );\n}\n\nexport function MaintenanceSettingsPanel() {\n',
      '      {/* Rubato: the models that title sessions (settings-layout-edits.mjs). */}\n'
        + '      <RubatoTitleModelsSection />\n'],
    // About: T3's version and updater rows give way to Rubato's About section above them.
    ['        {isElectron || HOSTED_APP_CHANNEL ? (\n          <AboutVersionSection />\n        ) : (\n',
      '        {/* Rubato: the app\'s version and updates are Rubato\'s About section (settings-layout-edits.mjs). */}\n'
        + '        {isElectron || HOSTED_APP_CHANNEL ? null : (\n',
      'replace'],
    // Kept, unused, so the next pin bump shows upstream's changes to it.
    ['function AboutVersionSection() {\n',
      '// Rubato: About shows Rubato\'s section instead (settings-layout-edits.mjs).\nexport function AboutVersionSection() {\n',
      'replace'],
  ],
  'apps/web/src/components/settings/VoiceSettingsPanel.tsx': [
    ['import { useSearchableSetting } from "./settingsSearch";\n',
      'import { RubatoVoiceSettingsSection } from "./RubatoVoiceSettings";\n'],
    ['      </SettingsSection>\n    </SettingsPageContainer>\n  );\n}\n',
      '      </SettingsSection>\n'
        + '      {/* Rubato: the composer microphone (voice-edits.mjs). */}\n'
        + '      <RubatoVoiceSettingsSection />\n'
        + '    </SettingsPageContainer>\n  );\n}\n',
      'replace'],
  ],
};
