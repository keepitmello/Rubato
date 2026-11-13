// Voice calls with companions (harness/companion/call-agent). The app half is ours: the call state
// (state/rubatoCall.ts), the ringing sheet and in-call bar over every window (RubatoCallLayer.tsx),
// and the call cards in a companion's room (RubatoCallCard.tsx, rubatoCallRoom.ts, drawn by
// RubatoSegnoChat.tsx). LiveKit's browser client is vendored as one self-contained module in the
// web app's public folder and loaded only when a call starts: the web app's lockfile does not take
// it, and the renderer is cross-origin to the server, so it cannot load it from a token-guarded
// route. The edits below register the server route, mount the layer at the root and put the call
// button in the composer.
export const callOverlays = [
  'apps/web/src/state/rubatoCall.ts',
  'apps/web/src/components/chat/RubatoCallLayer.tsx',
  'apps/web/src/components/chat/RubatoCallCard.tsx',
  'apps/web/src/components/chat/rubatoCallRoom.ts',
  'apps/web/src/components/chat/rubatoCallRoom.test.ts',
  'apps/web/src/components/chat/RubatoCall.css',
  'apps/web/src/components/chat/RubatoCallComposerButton.tsx',
  'apps/web/public/rubato-livekit-client.mjs',
];

export const callEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoCallRouteLayer } from "./RubatoServiceRoute.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoCallRouteLayer,\n'],
  ],
  // The call button sits in a companion room's composer beside dictation (user 2e97849e).
  'apps/web/src/components/chat/ChatComposer.tsx': [
    ['import { Button } from "../ui/button";', 'import { RubatoCallComposerButton } from "./RubatoCallComposerButton";\n'],
    ['                  {showComposerAttachAction ? (',
      '                  <RubatoCallComposerButton environmentId={environmentId} threadId={activeThreadId} />\n'],
  ],
  'apps/web/src/routes/__root.tsx': [
    ['import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";',
      'import { RubatoCallLayer } from "../components/chat/RubatoCallLayer";\n'],
    ['          <SshPasswordPromptDialog />', '          <RubatoCallLayer />\n'],
  ],
};
