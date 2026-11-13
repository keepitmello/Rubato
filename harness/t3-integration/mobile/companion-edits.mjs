// Companion rooms and calls in the Rubato iPhone app (intent rubato-ios-app). The screens and the
// call store are new files under features/companions; the native module under modules/rubato-call
// reports VoIP pushes to CallKit. The shell mounts them (rubato-shell/companionSurface.tsx), so no
// upstream file is edited here.
//
//   phone ── /rubato/companion ──▶ Mac   companions, room thread, picture
//   phone ── /rubato/call ──▶ Mac        dial, answer, decline, hangup, live, calls
//   phone ── wss (tailnet :7443) ──▶ LiveKit on the Mac (call-agent remote.mjs)
//   relay ── VoIP push ──▶ RubatoCallCenter.swift ──▶ CallKit ──▶ callStore.ts
const companions = 'apps/mobile/src/features/companions';
const callModule = 'apps/mobile/modules/rubato-call';

export const mobileCompanionOverlays = [
  `${companions}/index.ts`,
  `${companions}/copy.ts`,
  `${companions}/rubatoHttp.ts`,
  `${companions}/companionsStore.ts`,
  `${companions}/callStore.ts`,
  `${companions}/callTypes.ts`,
  `${companions}/ringCheck.ts`,
  `${companions}/ringCheck.test.ts`,
  `${companions}/roomModel.ts`,
  `${companions}/roomModel.test.ts`,
  `${companions}/BubbleMarkdown.tsx`,
  `${companions}/CompanionAvatar.tsx`,
  `${companions}/EdgeFade.tsx`,
  `${companions}/CallCard.tsx`,
  `${companions}/CallScreen.tsx`,
  `${companions}/CompanionListScreen.tsx`,
  `${companions}/CompanionRoomScreen.tsx`,
  `${companions}/RubatoCallHost.tsx`,
  `${callModule}/index.ts`,
  `${callModule}/expo-module.config.json`,
  `${callModule}/ios/RubatoCall.podspec`,
  `${callModule}/ios/RubatoCallAppDelegateSubscriber.swift`,
  `${callModule}/ios/RubatoCallCenter.swift`,
  `${callModule}/ios/RubatoCallModule.swift`,
];

export const mobileCompanionEdits = {};
