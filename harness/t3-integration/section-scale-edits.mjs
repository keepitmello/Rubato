// Section sizes (intent section-scale): seven parts each carry their own
// scale on top of the interface font size, 80%–150% in 10% steps: the rail,
// the sidebar's project title, the Recent box, the sidebar's thread cards, the
// home project tabs, the home thread list and the conversation.
//
// - The scales (sidebar/rubatoSectionScale.logic.ts) live in localStorage and
//   reach the page as --rubato-scale-<part> on <html>; rubatoSectionScale.css
//   zooms each part's root by its factor, so text, icons and row heights grow
//   together. Zoom sits inside the boxes dnd-kit moves and the message list
//   measures, never on them.
// - Hovering a part, Ctrl + / Ctrl − / Ctrl 0 on the Mac (Ctrl+Alt elsewhere,
//   where Ctrl +/- is the window zoom) changes only that part and shows a
//   brief notice (sidebar/RubatoSectionScale.tsx, mounted in AppSidebarLayout).
//   ⌘ +/- stays the window zoom and the preview zoom.
// - Settings > Appearance > Section sizes: a slider per part and a live
//   preview (settings/RubatoSectionSizes.tsx).
//
// The rail, project title and Recent box are found by the data attributes
// project-rail-edits.mjs already gives them; the home row carries its own in
// chat/RubatoHomeProjects.tsx. Registered last: it reads text other modules add.
export const sectionScaleOverlays = [
  'apps/web/src/components/sidebar/rubatoSectionScale.logic.ts',
  'apps/web/src/components/sidebar/rubatoSectionScale.logic.test.ts',
  'apps/web/src/components/sidebar/RubatoSectionScale.tsx',
  'apps/web/src/components/settings/RubatoSectionSizes.tsx',
  'apps/web/src/rubatoSectionScale.css',
];

export const sectionScaleEdits = {
  'apps/web/src/components/AppSidebarLayout.tsx': [
    ['import { SidebarBrandWidthProbe, SidebarChromeHeader } from "./sidebar/SidebarChrome";\n',
      'import { RubatoSectionScaleHost } from "./sidebar/RubatoSectionScale";\n'],
    ['        <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />\n',
      '        {/* Rubato: per-part sizes and their hover shortcut (section-scale-edits.mjs). */}\n        <RubatoSectionScaleHost />\n'],
  ],
  // The thread list and the search results: each <li> is a row whose content
  // zooms, so dnd-kit's translate on the <li> stays in window pixels.
  'apps/web/src/components/Sidebar.tsx': [
    ['import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";\n',
      'import { readSectionScales } from "./sidebar/rubatoSectionScale.logic";\n'],
    ['                  id="sidebar-thread-search-results"\n',
      '                  data-rubato-section="cards"\n'],
    ['                    role="presentation"\n                    className={cn(\n                      "relative flex flex-col gap-px",\n',
      '                    data-rubato-section="cards"\n'],
    // The pinned label zooms with the cards; the drag stop under it follows.
    ['SIDEBAR_DRAG_LABEL_HEIGHT * scale;',
      'SIDEBAR_DRAG_LABEL_HEIGHT * scale * (readSectionScales(window.localStorage).cards / 100);',
      'replace'],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    ['            data-assistant-citation-viewport="true"\n',
      '            data-rubato-section="messages"\n'],
  ],
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { SettingsGroup } from "./SettingsGroup";\n',
      'import { RubatoSectionSizesSection } from "./RubatoSectionSizes";\n'],
    ['      <TypographySection />\n    </SettingsPageContainer>\n',
      '      <TypographySection />\n      <RubatoSectionSizesSection />\n    </SettingsPageContainer>\n',
      'replace'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  {\n    id: "prompt-font",\n',
      [
        '  {',
        '    // Rubato: per-part sizes (section-scale-edits.mjs).',
        '    id: "section-sizes",',
        '    title: "Section sizes",',
        '    to: "/settings/appearance",',
        '    searchTerms: ["scale zoom size bigger smaller rail recent cards tabs messages sidebar home"],',
        '  },',
        '',
      ].join('\n')],
  ],
};
