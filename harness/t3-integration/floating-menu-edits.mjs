// The floating thread details (the popover under the toolbar's details button):
// - The run-context row names the workspace (Current checkout, Worktree) with the
//   folder icon. Upstream printed the machine there ("WY@Mac") once a host list
//   existed, so the row read as a machine while it chooses a folder; the machine
//   now rides along as a small tag at the row's end. The toolbar keeps upstream's
//   machine label, where the row is the host picker's only face.
// - "Add project script" is gone while the project has no scripts, saved or in a
//   checked-in t3.json: an empty row that only opens an editor. A project with
//   scripts still shows its run button and the import entries.
// - Team and Agents sections sit between Workspace and Version Control and show
//   what runs for this thread now (chat/RubatoThreadDetailsAgents.tsx).
export const floatingMenuOverlays = [
  'apps/web/src/components/chat/RubatoThreadDetailsAgents.tsx',
  'apps/web/src/components/chat/RubatoThreadDetailsAgents.test.tsx',
];

const lines = (...parts) => `${parts.join('\n')}\n`;

export const floatingMenuEdits = {
  'apps/web/src/components/BranchToolbar.tsx': [
    ['  const icon = showEnvironmentIndicator ? (\n',
      lines(
        '  // Rubato: in the details panel the machine is a tag at the row end (floating-menu-edits.mjs).',
        '  const icon = showEnvironmentIndicator && !isPanel ? ('),
      'replace'],
    [lines(
      '      <ComposerContextLabel displayMode={displayMode}>',
      '        {autoEnvironmentLabel ??',
      '          (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel)}',
      '      </ComposerContextLabel>',
      '    </>'),
      lines(
        '      <ComposerContextLabel displayMode={displayMode}>',
        '        {isPanel',
        '          ? workspaceLabel',
        '          : (autoEnvironmentLabel ??',
        '            (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel))}',
        '      </ComposerContextLabel>',
        '      {isPanel && showEnvironmentIndicator ? (',
        '        <span',
        '          data-run-host',
        '          title={`Runs on ${autoEnvironmentLabel ?? activeEnvironment?.label ?? "this machine"}`}',
        '          className="me-1.5 inline-flex min-w-0 max-w-[45%] shrink items-center gap-1 rounded-md bg-muted-foreground/10 px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"',
        '        >',
        '          {autoEnvironmentLabel ? (',
        '            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />',
        '          ) : (',
        '            <EnvironmentMachineIcon kind={activeEnvironment?.machine ?? "server"} className="size-3 shrink-0" />',
        '          )}',
        '          <span className="min-w-0 truncate">{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</span>',
        '        </span>',
        '      ) : null}',
        '    </>'),
      'replace'],
  ],
  'apps/web/src/components/BranchToolbar.panel.test.tsx': [
    ['    expect(trigger.textContent).toBe("local");\n',
      lines(
        '    // Rubato: the row names the workspace; the machine is its tag (floating-menu-edits.mjs).',
        '    expect(trigger.querySelector("[data-composer-label]")?.textContent).toBe("Worktree");',
        '    expect(trigger.querySelector("[data-run-host]")?.textContent).toBe("local");'),
      'replace'],
  ],
  'apps/web/src/components/chat/ThreadDetailsPanel.tsx': [
    ['import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";\n',
      lines(
        'import { RubatoThreadDetailsAgents } from "./RubatoThreadDetailsAgents";',
        'import type { AgentPanelModel } from "../rubatoAgentPanelModel";')],
    ['  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;\n}\n',
      lines(
        '  /** Rubato: what runs for this thread, for the Team and Agents sections (floating-menu-edits.mjs). */',
        '  rubatoAgents?: AgentPanelModel | undefined;')],
    ['              {props.activeProjectScripts ? (\n',
      lines(
        '              {/* Rubato: no empty "Add project script" row (floating-menu-edits.mjs). */}',
        '              {props.activeProjectScripts &&',
        '              (props.activeProjectScripts.length > 0 || fileScripts.length > 0) ? ('),
      'replace'],
    ['          {props.gitCwd ? (\n            <ThreadDetailsSection\n',
      lines(
        '          {density !== "essential" && props.rubatoAgents ? (',
        '            <RubatoThreadDetailsAgents',
        '              model={props.rubatoAgents}',
        '              environmentId={props.environmentId}',
        '              threadId={props.threadId}',
        '              separated={density === "full"}',
        '            />',
        '          ) : null}',
        '')],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['    onDeleteProjectScript: deleteProjectScriptStable,\n  };\n',
      '    rubatoAgents: agentPanelModel,\n'],
  ],
};
