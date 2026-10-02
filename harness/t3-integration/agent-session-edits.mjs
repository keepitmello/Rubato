// The Agents panel opens one agent's whole conversation (RubatoAgentSession.tsx) and can
// stop it or tell it something. The conversation is read from the agent's own session
// file under the thread's directory, so ChatView hands the panel that directory; the
// server half is /rubato/agents (RubatoServiceRoute.ts → src/agents/service.mjs).
export const agentSessionOverlays = [
  'apps/web/src/components/RubatoAgentSession.tsx',
  'apps/web/src/components/RubatoAgentSession.test.tsx',
  'apps/web/src/state/rubatoAgents.ts',
];

export const agentSessionEdits = {
  'apps/web/src/components/ChatView.tsx': [
    [
      '        environmentId={activeThreadRef?.environmentId ?? null}\n        threadId={activeThreadRef?.threadId ?? null}\n      />\n    ) : renderedRightPanelSurface?.kind === "device" ? (',
      '        environmentId={activeThreadRef?.environmentId ?? null}\n        threadId={activeThreadRef?.threadId ?? null}\n        cwd={gitCwd}\n      />\n    ) : renderedRightPanelSurface?.kind === "device" ? (',
      'replace',
    ],
  ],
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";', 'import { rubatoAgentsRouteLayer } from "./RubatoServiceRoute.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoAgentsRouteLayer,\n'],
  ],
};
