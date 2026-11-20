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
// - in the conversation, an Agent, task or team_create call is drawn as the agent or
//   taskforce it started, with the panel's row grammar (chat/RubatoSpawnRow.tsx), joined on
//   the call id the roster records.
//
// v0.1.11 draws a surface inside chat/RightPanelSurfaceContent.tsx and a work entry inside
// chat/TimelineWorkEntryRow.tsx, so the panel and the spawn row hook in there, and ChatView
// hands the surface content the model it already computes for the launcher badge.
export const agentsSurfaceOverlays = [
  'apps/web/src/components/rubatoAgentPanelModel.ts',
  'apps/web/src/components/RubatoAgentsPanel.tsx',
  'apps/web/src/components/rubatoAgentStatus.tsx',
  'apps/web/src/components/rubatoAgentStatus.test.tsx',
  'apps/web/src/components/RubatoAgentsPanel.test.tsx',
  'apps/web/src/components/rubatoAgentPanelModel.test.ts',
  'apps/web/src/state/rubatoSessionState.ts',
  'apps/web/src/state/rubatoSessionState.test.ts',
  'apps/web/src/components/chat/RubatoSpawnRow.tsx',
  'apps/web/src/components/chat/RubatoSpawnRow.test.tsx',
  'apps/web/src/rubatoPanelViews.ts',
  'apps/web/src/rubatoPanelViews.test.ts',
];

const lines = (...parts) => parts.join('\n');

const launcherItem = (reasons, badge) => lines(
  '    {',
  '      label: msg("Agents"),',
  '      icon: Bot,',
  '      shortcut: "A",',
  '      available: props.agentsAvailable === true,',
  `      disabledReason: messages(${reasons}.agents),`,
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
    ['  "side-chat",\n] as const;', '  "side-chat",\n  "agents",\n] as const;', 'replace'],
    ['  | { id: "pull-requests"; kind: "pull-requests" }\n', lines(
      '  | { id: "pull-requests"; kind: "pull-requests" }',
      '  /** Rubato: the thread\'s agents and taskforces (RubatoAgentsPanel.tsx). */',
      '  | { id: "agents"; kind: "agents" }',
      ''), 'replace'],
    ['    case "device":\n      return { id: "device", kind };\n',
      '    case "agents":\n      return { id: "agents", kind };\n'],
    [lines(
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
    [lines(
      '  sideChatAvailable: boolean;',
      '  sideChatDisabledReason: string | null;',
      '}) {',
      '  const gt = useGT();',
      ''), lines(
      '  /** Rubato: the Agents surface; panels other than a thread\'s leave these out. */',
      '  onAddAgents?: (() => void) | undefined;',
      '  agentsAvailable?: boolean | undefined;',
      '  /** Running + waiting subagents; badges the Agents row in the launcher. */',
      '  liveAgentCount?: number | undefined;',
      '  sideChatAvailable: boolean;',
      '  sideChatDisabledReason: string | null;',
      '}) {',
      '  const gt = useGT();',
      ''), 'replace'],
    ['  sideChat: msg("Side chats start after the first message."),\n} as const;',
      '  sideChat: msg("Side chats start after the first message."),\n  agents: msg("Agents are only available from a thread."),\n} as const;', 'replace'],
    ['  sideChat: msg("Available after the first message."),\n} as const;',
      '  sideChat: msg("Available after the first message."),\n  agents: msg("Available from a thread."),\n} as const;', 'replace'],
    [lines(
      '    {',
      '      label: msg("Linked items"),',
      '      icon: PullRequestGlyph.link,',
      '      shortcut: "L",',
      '      available: props.pullRequestsAvailable,',
      '      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.pullRequests),',
      '      onClick: props.onAddPullRequests,',
      '    },',
      ''), lines(
      '    {',
      '      label: msg("Linked items"),',
      '      icon: PullRequestGlyph.link,',
      '      shortcut: "L",',
      '      available: props.pullRequestsAvailable,',
      '      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.pullRequests),',
      '      onClick: props.onAddPullRequests,',
      '    },',
      '') + launcherItem('SURFACE_UNAVAILABLE_HINTS', true), 'replace'],
    [lines(
      '    {',
      '      label: msg("Linked items"),',
      '      icon: PullRequestGlyph.link,',
      '      shortcut: "L",',
      '      available: props.pullRequestsAvailable,',
      '      disabledReason: messages(SURFACE_DISABLED_REASONS.pullRequests),',
      '      onClick: props.onAddPullRequests,',
      '    },',
      ''), lines(
      '    {',
      '      label: msg("Linked items"),',
      '      icon: PullRequestGlyph.link,',
      '      shortcut: "L",',
      '      available: props.pullRequestsAvailable,',
      '      disabledReason: messages(SURFACE_DISABLED_REASONS.pullRequests),',
      '      onClick: props.onAddPullRequests,',
      '    },',
      '') + launcherItem('SURFACE_DISABLED_REASONS', false), 'replace'],
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
    ['    case "device":\n      return surface.title ?? surface.target?.name ?? resolve(msg("Device"));\n',
      '    case "agents":\n      return resolve(msg("Agents"));\n'],
    ['    case "device":\n      return surface.target?.platform === "ios" ? (\n',
      '    case "agents":\n      return <Bot className="size-3 shrink-0" />;\n'],
    [lines(
      '            deviceAvailable={props.deviceAvailable}',
      '            sideChatAvailable={props.sideChatAvailable === true}',), lines(
      '            deviceAvailable={props.deviceAvailable}',
      '            onAddAgents={props.onAddAgents}',
      '            agentsAvailable={props.agentsAvailable}',
      '            liveAgentCount={props.liveAgentCount}',
      '            sideChatAvailable={props.sideChatAvailable === true}',), 'replace'],
  ],
  'apps/web/src/components/chat/TimelineWorkEntryRow.tsx': [
    ['import { WorkLogDetails, WorkLogRow } from "./WorkLog";\n',
      'import { RubatoSpawnRow, useRubatoSpawn } from "./RubatoSpawnRow";\n'],
    ['export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: WorkEntryRowProps) {\n  const ctx = use(TimelineRowCtx);\n  const item = props.workEntry.projectedItem?.item;\n',
      'export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: WorkEntryRowProps) {\n  const ctx = use(TimelineRowCtx);\n  const item = props.workEntry.projectedItem?.item;\n  // Rubato: a spawn call is drawn as the agent it started (RubatoSpawnRow.tsx).\n  const rubatoSpawn = useRubatoSpawn(ctx.routeThreadKey, item);\n  if (rubatoSpawn) return <RubatoSpawnRow spawn={rubatoSpawn} />;\n',
      'replace'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { RightPanelSurfaceContent } from "./chat/RightPanelSurfaceContent";\n', lines(
      'import { RubatoAgentsPanel } from "./RubatoAgentsPanel";',
      'import {',
      '  deriveAgentPanelModel,',
      '  formatSpeedLabel,',
      '  rubatoAgentsFromSessionState,',
      '} from "./rubatoAgentPanelModel";',
      'import { useRubatoSessionState } from "../state/rubatoSessionState";',
      'import { watchPanelViews } from "../rubatoPanelViews";',
      '')],
    [lines(
      '  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(',
      '    activeThreadRef?.environmentId ?? null,',
      '  );',
      ''), lines(
      '  // Rubato: the Agents surface and the Speed label (agents-surface-edits.mjs).',
      '  const rubatoSessionState = useRubatoSessionState(isServerThread ? activeThreadRef : null);',
      '  const agentPanelModel = deriveAgentPanelModel({',
      '    agents: rubatoAgentsFromSessionState(rubatoSessionState),',
      '  });',
      '  const sessionSpeedLabel =',
      '    rubatoSessionState.speedIndex === null ? null : formatSpeedLabel(rubatoSessionState.speedIndex);',
      '  // What the Agents tab has open survives a thread switch until the tab closes (rubatoPanelViews.ts).',
      '  useEffect(() => watchPanelViews(), []);',
      '  const addAgentsSurface = () => {',
      '    if (!activeThreadRef) return;',
      '    useRightPanelStore.getState().open(activeThreadRef, "agents");',
      '  };',
      '  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(',
      '    activeThreadRef?.environmentId ?? null,',
      '  );',
      ''), 'replace'],
    ['      sideChatParentPanel={sideChatParentPanel}\n', lines(
      '      agentPanelModel={agentPanelModel}',
      '      cwd={gitCwd}',
      '')],
    // The Speed label sits in the composer's footer (apply.mjs's ChatComposer edits); the
    // prompt cache goes to Thread details with the context window (cache-edits.mjs).
    ['                                canOperateThread={canOperateThread}\n                                reportedModelSelection={reportedModelSelection}\n',
      '                                sessionSpeedLabel={sessionSpeedLabel}\n'],
    ['          onAddDevice={addDeviceSurfaceStable}\n          onAddSideChat=',
      panelProps('          ') + '          onAddSideChat=', 'replace'],
  ],
  'apps/web/src/components/chat/RightPanelSurfaceContent.tsx': [
    ['import SideChatPane from "./SideChatPane";\n', lines(
      'import { RubatoAgentsPanel } from "../RubatoAgentsPanel";',
      'import type { AgentPanelModel } from "../rubatoAgentPanelModel";',
      '')],
    ['  readonly sideChatParentPanel: SideChatParentPanel;\n', lines(
      '  /** Rubato: the thread\'s agents and taskforces (RubatoAgentsPanel.tsx). */',
      '  readonly agentPanelModel: AgentPanelModel;',
      '  /** The thread\'s session directory; an agent\'s conversation is read under it. */',
      '  readonly cwd: string | null;',
      '  readonly sideChatParentPanel: SideChatParentPanel;',
      ''), 'replace'],
    [lines(
      '    case "device":',
      '      return (',
      '        <Suspense fallback={null}>',
      '          <DevicePanel',
      ''), lines(
      '    case "agents":',
      '      return (',
      '        <RubatoAgentsPanel',
      '          model={props.agentPanelModel}',
      '          environmentId={props.environmentId}',
      '          threadId={threadRef.threadId}',
      '          cwd={props.cwd}',
      '        />',
      '      );',
      '    case "device":',
      '      return (',
      '        <Suspense fallback={null}>',
      '          <DevicePanel',
      ''), 'replace'],
  ],
};
