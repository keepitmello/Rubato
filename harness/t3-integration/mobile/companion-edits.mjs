// Companion rooms and calls in the Rubato iPhone app (intent rubato-ios-app). The screens and the
// call store are new files under features/companions; the native module under modules/rubato-call
// reports VoIP pushes to CallKit. The shell mounts them (rubato-shell/companionSurface.tsx); the
// only upstream edit exports the thread feed's attachment renderers for the room.
//
//   phone ── /rubato/companion ──▶ Mac   companions, room thread, picture
//   phone ── /rubato/call ──▶ Mac        dial, answer, decline, hangup, live, calls
//   phone ── wss (tailnet :7443) ──▶ LiveKit on the Mac (call-agent remote.mjs)
//   relay ── VoIP push ──▶ RubatoCallCenter.swift ──▶ CallKit ──▶ callStore.ts
//
// Every request to a Rubato route carries the headers rubatoHttp.ts gets from
// client-runtime's state/rubatoEnvironmentHttp.ts (an overlay of ours): the bearer of an older
// pairing, or upstream's DPoP-bound token with a proof per request. Its one upstream hook is the
// package export below (one anchor per bump).
const companions = 'apps/mobile/src/features/companions';
const callModule = 'apps/mobile/modules/rubato-call';

export const mobileCompanionOverlays = [
  `${companions}/index.ts`,
  `${companions}/copy.ts`,
  `${companions}/rubatoHttp.ts`,
  `${companions}/companionNames.ts`,
  `${companions}/companionNotification.ts`,
  `${companions}/companionNotification.test.ts`,
  `${companions}/CompanionNamesSettingsScreen.tsx`,
  `${companions}/companionModel.ts`,
  `${companions}/companionModel.test.ts`,
  `${companions}/companionsStore.ts`,
  `${companions}/callStore.ts`,
  `${companions}/callTypes.ts`,
  `${companions}/ringCheck.ts`,
  `${companions}/ringCheck.test.ts`,
  `${companions}/roomMedia.tsx`,
  `${companions}/roomModel.ts`,
  `${companions}/roomModel.test.ts`,
  `${companions}/roomThread.ts`,
  `${companions}/BubbleAttachments.tsx`,
  `${companions}/BubbleMarkdown.tsx`,
  `${companions}/BubbleFiles.tsx`,
  `${companions}/RoomMotion.tsx`,
  `${companions}/CompanionAvatar.tsx`,
  `${companions}/EdgeFade.tsx`,
  `${companions}/CallCard.tsx`,
  `${companions}/CallScreen.tsx`,
  `${companions}/CallTranscriptScreen.tsx`,
  `${companions}/CompanionListScreen.tsx`,
  `${companions}/CompanionRoomScreen.tsx`,
  `${companions}/RubatoCallHost.tsx`,
  `${callModule}/index.ts`,
  `${callModule}/expo-module.config.json`,
  `${callModule}/ios/RubatoCall.podspec`,
  `${callModule}/ios/RubatoCallAppDelegateSubscriber.swift`,
  `${callModule}/ios/CompanionIdentity.swift`,
  `${callModule}/ios/RubatoCallCenter.swift`,
  `${callModule}/ios/RubatoCallModule.swift`,
  'apps/mobile/targets/notification-service/NotificationService.swift',
  'packages/client-runtime/src/state/rubatoEnvironmentHttp.ts',
  'packages/client-runtime/src/state/rubatoEnvironmentHttp.test.ts',
];

// The room draws attachments with the thread feed's own renderers, which the feed keeps private.
const exported = (declaration) => [declaration, `export ${declaration}`, 'replace'];

export const mobileCompanionEdits = {
  'packages/client-runtime/package.json': [
    ['    "./state/environmentHttpAuth": {\n',
      '    "./state/rubatoEnvironmentHttp": {\n      "types": "./src/state/rubatoEnvironmentHttp.ts",\n      "default": "./src/state/rubatoEnvironmentHttp.ts"\n    },\n'],
  ],
  'apps/mobile/src/features/threads/ThreadFeed.tsx': [
    exported('function MessageAttachmentImage(props: {'),
    exported('function MessageAttachmentFile(props: {'),
    exported('function MessageAttachmentUnknown(props: { readonly name: string }) {'),
    exported('function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {'),
    exported('function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {'),
  ],
  // A companion's room sends during its work as a steer, whatever the phone's follow-up setting
  // says (CompanionRoomScreen.tsx, user item 6b6a88c5): the room never shows that work.
  'apps/mobile/src/state/use-thread-composer-state.ts': [
    ['import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";',
      'import { DEFAULT_FOLLOW_UP_BEHAVIOR, type FollowUpBehavior } from "../lib/followUpBehavior";', 'replace'],
    ['export function useThreadComposerState(input: {\n',
      'export function useThreadComposerState(input: {\n  /** Rubato: a companion\'s room steers during its work, whatever the follow-up setting says. */\n  readonly followUpBehavior?: FollowUpBehavior;\n', 'replace'],
    ['  const followUpBehavior = AsyncResult.isSuccess(preferencesResult)\n    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)\n    : DEFAULT_FOLLOW_UP_BEHAVIOR;\n',
      '  const followUpBehavior =\n    input.followUpBehavior ??\n    (AsyncResult.isSuccess(preferencesResult)\n      ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)\n      : DEFAULT_FOLLOW_UP_BEHAVIOR);\n', 'replace'],
  ],
};
