// The right panel's Agents surface. T3 v0.1.0 removed it ("lineage lives in the thread title
// bar"); Rubato keeps it, because its panel (RubatoAgentsPanel.tsx) carries what the title bar
// does not: taskforce cards with their members and shared board, and each agent's whole
// conversation on click (agent-session-edits.mjs). This puts back what the surface needs:
//
// - the "agents" surface kind in the right panel store, kept by the stored-state migration
//   that would otherwise drop it;
// - Agents in the surface launcher and the "+" menu (shortcut A), its tab title and icon,
//   and the live-agent badge on the launcher row;
// - ChatView renders the panel from rubatoAgentPanelModel.ts, over the roster the server folds
//   from the engine (state/rubatoSessionState.ts): T3's V2 rows see a Rubato spawn as a plain
//   tool call. The same poll gives the composer its Speed label.
//
// side-chat-edits.mjs inserts its own surface beside these lines, so it registers after.
export const agentsSurfaceOverlays = [
  'apps/web/src/components/rubatoAgentPanelModel.ts',
  'apps/web/src/components/RubatoAgentsPanel.tsx',
  'apps/web/src/components/RubatoAgentsPanel.test.tsx',
  'apps/web/src/components/rubatoAgentPanelModel.test.ts',
  'apps/web/src/state/rubatoSessionState.ts',
];

const lines = (...parts) => parts.join('\n');

const launcherItem = (reasons, badge) => lines(
  '    {',
  '      label: "Agents",',
  '      icon: Bot,',
  '      shortcut: "A",',
  '      available: props.agentsAvailable === true,',
  `      disabledReason: ${reasons}.agents,`,
  '      onClick: () => props.onAddAgents?.(),',
  ...(badge ? ['      badgeCount: props.liveAgentCount ?? 0,'] : []),
  '    },',
  '');

const panelProps = (indent) => lines(
  `${indent}onAddDevice={addDeviceSurfaceStable}`,
  `${indent}onAddAgents={addAgentsSurface}`,
  `${indent}agentsAvailable={activeThreadRef !== null}`,
  `${indent}// Rubato: no badge while the roster itself is on screen.`,
  `${indent}liveAgentCount={`,
  `${indent}  rightPanelOpen && activeRightPanelSurface?.kind === "agents" ? 0 : agentPanelModel.liveCount`,
  `${indent}}`,
  '');

export const agentsSurfaceEdits = {
  'apps/web/src/rightPanelStore.ts': [
    ['  "pull-requests",\n] as const;', '  "pull-requests",\n  "agents",\n] as const;', 'replace'],
    ['  | { id: "pull-requests"; kind: "pull-requests" };', lines(
      '  | { id: "pull-requests"; kind: "pull-requests" }',
      '  /** Rubato: the thread\'s agents and taskforces (RubatoAgentsPanel.tsx). */',
      '  | { id: "agents"; kind: "agents" };'), 'replace'],
    ['    case "device":\n      return { id: "device", kind };\n',
      '    case "agents":\n      return { id: "agents", kind };\n'],
    [lines(
      '                    // Removed surfaces: plans render inline, agents in thread lineage.',
      '                    const kind = (surface as { kind?: string }).kind;',
      '                    if (kind === "plan" || kind === "agents") return [];'), lines(
      '                    // Removed surfaces: plans render inline. Rubato keeps agents.',
      '                    const kind = (surface as { kind?: string }).kind;',
      '                    if (kind === "plan") return [];'), 'replace'],
  ],
  // Upstream's migration test drops a stored Agents tab; Rubato keeps it.
  'apps/web/src/rightPanelStore.test.ts': [
    ['    { kind: "plan", isOpen: true },\n    { kind: "agents", isOpen: true },\n    { kind: "agents", isOpen: false },\n  ])',
      '    { kind: "plan", isOpen: true },\n  ])', 'replace'],
    ['  it("persists inline preference without restoring an open popover", () => {\n', lines(
      '  // Rubato: the Agents tab survives the stored-state migration (agents-surface-edits.mjs).',
      '  it("keeps a stored Agents tab", () => {',
      '    const panelState = {',
      '      isOpen: true,',
      '      activeSurfaceId: "agents",',
      '      surfaces: [{ id: "agents", kind: "agents" }, { id: "diff", kind: "diff" }],',
      '    };',
      '    expect(',
      '      migratePersistedRightPanelState({ byThreadKey: { "env-1:thread-A": panelState } }),',
      '    ).toEqual({',
      '      byThreadKey: { "env-1:thread-A": panelState },',
      '      threadPanelVisibilityByThreadKey: {},',
      '    });',
      '  });',
      '',
      '')],
  ],
  'apps/web/src/components/RightPanelTabs.tsx': [
    ['  Smartphone,\n  ChevronDown,\n', '  Bot,\n'],
    ['  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;\n  children: ReactNode;\n', lines(
      '  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;',
      '  /** Rubato: the Agents surface; panels other than a thread\'s leave these out. */',
      '  onAddAgents?: (() => void) | undefined;',
      '  agentsAvailable?: boolean | undefined;',
      '  /** Running + waiting subagents; badges the Agents row in the launcher. */',
      '  liveAgentCount?: number | undefined;',
      '  children: ReactNode;',
      ''), 'replace'],
    ['  deviceAvailable: boolean;\n}) {\n  // -1 means no highlight', lines(
      '  deviceAvailable: boolean;',
      '  onAddAgents?: (() => void) | undefined;',
      '  agentsAvailable?: boolean | undefined;',
      '  liveAgentCount?: number | undefined;',
      '}) {',
      '  // -1 means no highlight'), 'replace'],
    ['  device: "Devices are only available from a thread.",\n} as const;',
      '  device: "Devices are only available from a thread.",\n  agents: "Agents are only available from a thread.",\n} as const;', 'replace'],
    ['  device: "Available from a thread.",\n} as const;',
      '  device: "Available from a thread.",\n  agents: "Available from a thread.",\n} as const;', 'replace'],
    ['      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequests,\n      onClick: props.onAddPullRequests,\n    },\n',
      '      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequests,\n      onClick: props.onAddPullRequests,\n    },\n' + launcherItem('SURFACE_UNAVAILABLE_HINTS', true), 'replace'],
    ['      disabledReason: SURFACE_DISABLED_REASONS.pullRequests,\n      onClick: props.onAddPullRequests,\n    },\n',
      '      disabledReason: SURFACE_DISABLED_REASONS.pullRequests,\n      onClick: props.onAddPullRequests,\n    },\n' + launcherItem('SURFACE_DISABLED_REASONS', false), 'replace'],
    ['        <Icon className={iconClassName} />\n      </span>', lines(
      '        <Icon className={iconClassName} />',
      '        {(("badgeCount" in action ? action.badgeCount : 0) ?? 0) > 0 ? (',
      '          <span',
      '            aria-hidden',
      '            className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"',
      '          >',
      '            {"badgeCount" in action ? action.badgeCount : null}',
      '          </span>',
      '        ) : null}',
      '      </span>'), 'replace'],
    ['    case "device":\n      return surface.title ?? surface.target?.name ?? "Device";\n',
      '    case "agents":\n      return "Agents";\n'],
    ['    case "device":\n      return surface.target?.platform === "ios" ? (\n',
      '    case "agents":\n      return <Bot className="size-3 shrink-0" />;\n'],
    ['            deviceAvailable={props.deviceAvailable}\n          />', lines(
      '            deviceAvailable={props.deviceAvailable}',
      '            onAddAgents={props.onAddAgents}',
      '            agentsAvailable={props.agentsAvailable}',
      '            liveAgentCount={props.liveAgentCount}',
      '          />'), 'replace'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { ThreadPullRequestsPanel } from "./pullRequest/ThreadPullRequestsPanel";\n', lines(
      'import { RubatoAgentsPanel } from "./RubatoAgentsPanel";',
      'import {',
      '  deriveAgentPanelModel,',
      '  formatSpeedLabel,',
      '  rubatoAgentsFromSessionState,',
      '} from "./rubatoAgentPanelModel";',
      'import { useRubatoSessionState } from "../state/rubatoSessionState";',
      '')],
    ['  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(\n', lines(
      '  // Rubato: the Agents surface and the Speed label (agents-surface-edits.mjs).',
      '  const rubatoSessionState = useRubatoSessionState(isServerThread ? activeThreadRef : null);',
      '  const agentPanelModel = useMemo(',
      '    () => deriveAgentPanelModel({ agents: rubatoAgentsFromSessionState(rubatoSessionState) }),',
      '    [rubatoSessionState],',
      '  );',
      '  const sessionSpeedLabel =',
      '    rubatoSessionState.speedIndex === null ? null : formatSpeedLabel(rubatoSessionState.speedIndex);',
      '  const addAgentsSurface = useCallback(() => {',
      '    if (!activeThreadRef) return;',
      '    useRightPanelStore.getState().open(activeThreadRef, "agents");',
      '  }, [activeThreadRef]);',
      '')],
    ['    ) : renderedRightPanelSurface?.kind === "device" ? (\n', lines(
      '    ) : renderedRightPanelSurface?.kind === "agents" ? (',
      '      <RubatoAgentsPanel',
      '        model={agentPanelModel}',
      '        environmentId={activeThreadRef?.environmentId ?? null}',
      '        threadId={activeThreadRef?.threadId ?? null}',
      '        cwd={gitCwd}',
      '      />',
      '')],
    ['                              activeContextWindow={activeContextWindow}\n',
      '                              activeContextWindow={activeContextWindow}\n                              sessionSpeedLabel={sessionSpeedLabel}\n', 'replace'],
    ['          onAddDevice={addDeviceSurfaceStable}\n          browserAvailable=', panelProps('          ') + '          browserAvailable=', 'replace'],
    ['            onAddDevice={addDeviceSurfaceStable}\n            browserAvailable=', panelProps('            ') + '            browserAvailable=', 'replace'],
  ],
};
