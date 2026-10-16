// Rewinding to a finished tool step, not only to a message of mine — server half on T3's V2
// orchestrator. The route and its contract are in overlay/apps/server/src/RubatoStepRewind.ts;
// the engine lands on the step's last tool result (pi-runtime conversation-rewind), the cut
// turn's later rows move onto a rolled-back run (RubatoThreadImporter cutRun), and continue
// rides T3's own resume of an interrupted run. The web hover/card UI is step-rewind-ui-edits.mjs.
export const stepRewindOverlays = [
  'apps/server/src/RubatoStepRewind.ts',
];

export const stepRewindEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoStepRewindRouteLayer } from "./RubatoStepRewind.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoStepRewindRouteLayer,\n'],
  ],
};
