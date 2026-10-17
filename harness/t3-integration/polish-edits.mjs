// Rubato polish on T3's surfaces. Most of it is CSS in one overlay file,
// overlay/apps/web/src/rubatoPolish.css, imported at the top of index.css: hairlines,
// a rim of light and layered shadows on the glass that floats above content, a
// toolbar capsule, a right panel that pairs with the left sidebar, a quieter
// timeline minimap. Colors come from the theme roles, so every Rubato theme in
// light and dark gets the same treatment (theme-edits.mjs).
//
// The edits below change behavior or markup that CSS cannot reach:
// - Thread details hang from their toolbar button as a popover with a caret. When
//   the canvas has no room beside the chat, T3 floated them over the chat; Rubato
//   leaves them hidden instead and the button says why. The open state is kept, so
//   the details come back when room returns. Commit & push and project scripts live
//   only in this panel, so they wait for a wider canvas too.
// - The details show their section headings (Workspace, Version Control).
// - "Open a surface" in the empty right panel fills the panel width with larger rows.
// - An unsent draft is a state, not a warning: its sidebar row keeps the normal
//   surface and the pen turns the sidebar's muted color instead of warning yellow.
export const polishOverlays = [
  'apps/web/src/rubatoPolish.css',
  'apps/web/src/components/chat/rubatoDetailsCaret.ts',
];

export const polishEdits = {
  'apps/web/src/components/Sidebar.tsx': [
    [
      'const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";\nconst draftPenClassName = "size-3 shrink-0 text-warning-foreground";\n',
      [
        '// Rubato: an unsent draft is a state, not a warning (polish-edits.mjs).',
        'const draftSurfaceClassName = "bg-transparent hover:bg-sidebar-row-hover";',
        'const draftPenClassName = "size-3 shrink-0 text-sidebar-muted-foreground";',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/index.css': [
    ['@import "tailwindcss";\n', '@import "tailwindcss";\n@import "./rubatoPolish.css";\n', 'replace'],
  ],
  'apps/web/src/components/chat/ThreadDetailsCard.tsx': [
    // The popover branch below was this constant's only use.
    ['import {\n  THREAD_DETAILS_CARD_GAP,\n  resolveThreadDetailsCardDensity,\n', 'import {\n  resolveThreadDetailsCardDensity,\n', 'replace'],
    [
      'import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";\n',
      'import { Popover, PopoverCreateHandle } from "../ui/popover";\nimport { useDetailsCaretOffset } from "./rubatoDetailsCaret";\n',
      'replace',
    ],
    [
      '  const mode = placement ? "inline" : "popover";\n',
      [
        '  const mode = placement ? "inline" : "popover";',
        '  const [asideElement, setAsideElement] = useState<HTMLElement | null>(null);',
        '  const caretOffset = useDetailsCaretOffset(asideElement);',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '            data-density={density}\n            data-thread-details-panel="inline"\n          >\n            {card}\n          </aside>\n',
      [
        '            data-density={density}',
        '            data-thread-details-panel="inline"',
        '            ref={setAsideElement}',
        '          >',
        '            {caretOffset !== null ? (',
        '              <span aria-hidden data-rubato-popover-caret style={{ left: caretOffset }} />',
        '            ) : null}',
        '            {card}',
        '          </aside>',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      [
        '      ) : (',
        '        <PopoverPopup',
        '          anchor={anchor}',
        '          align="end"',
        '          // Lines the card up with the find bar: the panel pads its card by 8px.',
        '          alignOffset={THREAD_DETAILS_CARD_GAP - 8}',
        '          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}',
        '          side="bottom"',
        '          sideOffset={topInset}',
        '          variant="panel"',
        '          padding="none"',
        '        >',
        '          <div data-density={density} data-thread-details-panel="popover">',
        '            {card}',
        '          </div>',
        '        </PopoverPopup>',
        '      )}',
        '',
      ].join('\n'),
      [
        '      ) : // Rubato: no room beside the chat, so the details stay hidden instead of',
        '      // covering it; the toolbar button says why (polish-edits.mjs).',
        '      null}',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/components/chat/PanelLayoutControls.tsx': [
    [
      'import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";\n',
      'import { PopoverCreateHandle } from "../ui/popover";\n',
      'replace',
    ],
    [
      [
        '        ? threadPanelPresentation === "popover"',
        '          ? threadPanelTooltip(',
        '              <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />,',
        '            )',
        '          : threadPanelTooltip(threadPanelToggle)',
        '',
      ].join('\n'),
      [
        '        ? threadPanelPresentation === "popover"',
        '          ? (',
        '              // Rubato: no room beside the chat; the details stay hidden rather than',
        '              // cover it, and come back when the canvas widens (polish-edits.mjs).',
        '              <Tooltip>',
        '                <TooltipTrigger render={<span className="flex shrink-0" />}>',
        '                  <Toggle',
        '                    className="relative shrink-0 [-webkit-app-region:no-drag]"',
        '                    pressed={false}',
        '                    disabled',
        '                    aria-label="Toggle thread details panel"',
        '                    variant="ghost"',
        '                    size="sm"',
        '                  >',
        '                    <SquareMenuIcon className="size-4" />',
        '                  </Toggle>',
        '                </TooltipTrigger>',
        '                <TooltipPopup side="bottom">',
        '                  Widen the window or close the right panel to show thread details',
        '                </TooltipPopup>',
        '              </Tooltip>',
        '            )',
        '          : threadPanelTooltip(threadPanelToggle)',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/components/chat/ThreadDetailsPanel.tsx': [
    [
      '            title="Workspace"\n            separated={false}\n            showHeading={false}\n',
      '            title="Workspace"\n            separated={false}\n            showHeading\n',
      'replace',
    ],
    [
      '              title="Version Control"\n              showHeading={false}\n',
      '              title="Version Control"\n              showHeading\n',
      'replace',
    ],
  ],
  'apps/web/src/components/RightPanelTabs.tsx': [
    // The content card is drawn only around an opened surface. Marking the empty state
    // here keeps the CSS off :has(), which re-ran style on every streamed message.
    [
      '      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>\n',
      '      <div\n        className="flex min-h-0 flex-1 flex-col"\n        data-right-panel-surface-content\n        data-surface-empty={props.activeSurfaceId === null ? "" : undefined}\n      >\n',
      'replace',
    ],
    [
      [
        '      <div className="w-full max-w-xs py-6">',
        '        <h3 className="mb-3 text-center font-medium text-foreground text-sm">Open a surface</h3>',
        '        <div className="flex flex-col gap-0.5">',
        '',
      ].join('\n'),
      [
        '      <div className="w-full max-w-md py-6">',
        '        <h3 className="mb-4 text-center font-semibold text-[0.9375rem] text-foreground">',
        '          Open a surface',
        '        </h3>',
        '        <div className="flex flex-col gap-1">',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '"flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",\n                    isHighlighted(action) && "bg-accent/60",\n                  )}\n                >\n                  {actionIcon(action, "size-4")}\n',
      '"flex h-10 w-full cursor-pointer items-center gap-3 rounded-(--control-radius) px-3 text-left text-[0.9375rem] transition-colors group-hover:bg-accent/60",\n                    isHighlighted(action) && "bg-accent/60",\n                  )}\n                >\n                  {actionIcon(action, "size-[1.125rem]")}\n',
      'replace',
    ],
    [
      '"flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50",\n                      surfaceGroupStartClass(actions, index),\n                    )}\n                  >\n                    {actionIcon(action, "size-4")}\n',
      '"flex h-10 w-full cursor-default items-center gap-3 rounded-(--control-radius) px-3 text-left text-[0.9375rem] opacity-50",\n                      surfaceGroupStartClass(actions, index),\n                    )}\n                  >\n                    {actionIcon(action, "size-[1.125rem]")}\n',
      'replace',
    ],
  ],
};
