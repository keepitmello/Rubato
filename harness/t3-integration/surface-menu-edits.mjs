// The surface launcher (empty right panel) and the tab bar's "+" menu list nine
// surfaces in one flat column, which did not read at a glance. Both now follow
// rubatoSurfaceGroups.ts: Agents | Files, Markdown note, Terminal | Browser,
// Device | Diff, Pull request, Linked pull requests, with a thin rule between
// groups. Shortcut letters are unchanged.
export const surfaceMenuOverlays = [
  'apps/web/src/components/rubatoSurfaceGroups.ts',
  'apps/web/src/components/rubatoSurfaceGroups.test.ts',
];

export const surfaceMenuEdits = {
  'apps/web/src/components/RightPanelTabs.tsx': [
    ['import { cn } from "~/lib/utils";\n',
      'import { orderSurfaceActions, surfaceGroupStartClass } from "./rubatoSurfaceGroups";\n'],
    // Launcher: arrows walk availableActions, which derives from this ordered list.
    ['  const actions = [\n', '  const unorderedActions = [\n', 'replace'],
    ['  type SurfaceAction = (typeof actions)[number];\n',
      '  const actions = orderSurfaceActions(unorderedActions);\n\n'],
    ['          {actions.map((action) =>\n', '          {actions.map((action, index) =>\n', 'replace'],
    ['                className="group relative"\n',
      '                className={cn("group relative", surfaceGroupStartClass(actions, index))}\n',
      'replace'],
    ['                    className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50"\n',
      '                    className={cn(\n                      "flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50",\n                      surfaceGroupStartClass(actions, index),\n                    )}\n',
      'replace'],
    // "+" menu
    ['                  {addSurfaceActions.map((action) => {\n                    const Icon = action.icon;\n',
      '                  {orderSurfaceActions(addSurfaceActions).map((action, index, ordered) => {\n                    const Icon = action.icon;\n                    const groupStart = surfaceGroupStartClass(ordered, index);\n',
      'replace'],
    ['                            className="[&>svg:last-child]:ms-0"\n',
      '                            className={cn("[&>svg:last-child]:ms-0", groupStart)}\n',
      'replace'],
    ['                      <SurfaceMenuItem\n                        key={action.label}\n',
      '                      <SurfaceMenuItem\n                        key={action.label}\n                        className={groupStart}\n',
      'replace'],
    ['  shortcut: string;\n  onClick: () => void;\n  children: ReactNode;\n}) {\n  const item = (\n    <MenuItem\n      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}\n',
      '  shortcut: string;\n  onClick: () => void;\n  children: ReactNode;\n  className?: string | undefined;\n}) {\n  const item = (\n    <MenuItem\n      className={cn(!props.available && "data-disabled:pointer-events-auto", props.className)}\n',
      'replace'],
  ],
};
