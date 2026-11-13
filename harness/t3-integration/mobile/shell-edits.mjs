// The Rubato iPhone app shell: T3's apps/mobile under Rubato's name and Apple team, with
// T3's cloud (Clerk login, T3 Connect relay, Expo updates and project) left out, the
// companions as the first tab, and each Rubato model drawn with its vendor's logo.
//
//   app.config.ts              name, bundle id com.keepitmello.rubato, team 5WGZKZGPQS,
//                              no Clerk plugin/associated domains, no OTA updates, no widget
//                              or share extensions (each needs its own app id and app group)
//   workspace tabs             companions | threads | pull requests; companions opens first
//   Stack.tsx                  CompanionRoom route (companions/:companionId)
//   ProviderIcon.tsx           rubato-pi models: vendor glyph (rubatoModelGlyph.ts)
//
// The app icon and splash are PNGs, which overlays (text only) cannot carry: build-ios.sh
// writes apps/mobile/assets/rubato/ from assets/Rubato.png before prebuild.
import { readFileSync } from 'node:fs';

// T3's mobile theme tests name T3's palettes (grove, iris, t3-chat), which the Rubato library
// replaced; theme-tests.json moves them onto Rubato's five. Generated with lock-diff.mjs from
// the pin's files and their edited copies.
const themeTests = JSON.parse(readFileSync(new URL('./theme-tests.json', import.meta.url), 'utf8'));

export const shellOverlays = [
  'apps/mobile/src/components/rubatoModelGlyph.ts',
  'apps/mobile/src/components/rubatoModelGlyph.test.ts',
  'apps/mobile/src/components/RubatoVendorMark.tsx',
  'apps/mobile/src/features/rubato-shell/companionSurface.tsx',
  'apps/mobile/src/features/rubato-shell/companionThreads.ts',
  'apps/mobile/src/features/rubato-shell/companionThreadFilter.ts',
  'apps/mobile/src/features/rubato-shell/companionThreadFilter.test.ts',
  'apps/mobile/src/features/rubato-voice/macVoiceTranscriber.ts',
  'apps/mobile/src/features/rubato-voice/macVoiceFailures.ts',
  'apps/mobile/src/features/rubato-voice/macVoiceFailures.test.ts',
  'apps/mobile/src/features/rubato-shell/companionNotifications.ts',
  'apps/mobile/src/features/rubato-shell/companionNotifications.test.ts',
  'apps/mobile/targets/notification-service/expo-target.config.js',
];

const RUBATO_ICON = './assets/rubato/icon.png';

export const shellEdits = {
  ...themeTests,
  'apps/mobile/app.config.ts': [
    ['    appName: "T3 Code Dev",\n    scheme: "t3code-dev",\n    iosBundleIdentifier: "com.t3tools.t3code.dev",',
      '    appName: "Rubato Dev",\n    scheme: "rubato-dev",\n    iosBundleIdentifier: "com.keepitmello.rubato.dev",', 'replace'],
    ['    appName: "T3 Code Preview",\n    scheme: "t3code-preview",\n    iosBundleIdentifier: "com.t3tools.t3code.preview",',
      '    appName: "Rubato Preview",\n    scheme: "rubato-preview",\n    iosBundleIdentifier: "com.keepitmello.rubato.preview",', 'replace'],
    ['    appName: "T3 Code",\n    scheme: "t3code",\n    iosBundleIdentifier: "com.t3tools.t3code",',
      '    appName: "Rubato",\n    scheme: "rubato",\n    iosBundleIdentifier: "com.keepitmello.rubato",', 'replace'],
    // Personal-team builds keep their own bundle id; every other build is Rubato's.
    ['const dmSansFonts = {',
      '// Rubato: the icon and splash build-ios.sh writes from harness/t3-integration/assets/Rubato.png.\n'
      + `const RUBATO_ICON = "${RUBATO_ICON}";\n\n`],
    ['  slug: "t3-code",', '  slug: "rubato",', 'replace'],
    // Rubato's own version line; build-ios.sh stamps the build number.
    ['  version: "2.0.0",', '  version: "1.0.0",', 'replace'],
    ['  icon: variant.assets.appIcon,\n  userInterfaceStyle', '  icon: RUBATO_ICON,\n  userInterfaceStyle', 'replace'],
    // T3's Expo project serves T3's JavaScript; a Rubato binary must never load it.
    ['  updates: {\n    enabled: repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",\n    url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",\n    checkAutomatically: "ON_LOAD",\n    fallbackToCacheTimeout: 0,\n  },',
      '  updates: {\n    // Rubato: no over-the-air updates; T3\'s Expo project serves T3\'s JavaScript.\n    enabled: false,\n  },', 'replace'],
    ['    icon: variant.assets.iosIcon,', '    icon: RUBATO_ICON,', 'replace'],
    // Companion messages as Communication Notifications, and the App Group the app shares with
    // its notification service extension (targets/notification-service) and CallKit.
    ['      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],\n',
      '      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],\n      "com.apple.developer.usernotifications.communication": true,\n      "com.apple.security.application-groups": ["group.com.keepitmello.rubato"],\n', 'replace'],
    ['      NSAppTransportSecurity: {\n        NSAllowsArbitraryLoads: true,\n      },\n',
      '      NSAppTransportSecurity: {\n        NSAllowsArbitraryLoads: true,\n      },\n      NSUserActivityTypes: ["INSendMessageIntent"],\n', 'replace'],
    // Rubato's team; Clerk's applinks/webcredentials domain belongs to T3's login.
    ['    appleTeamId: "ARK85ZXQ4Z",\n    associatedDomains: [\n      `applinks:${variant.relyingParty}`,\n      `webcredentials:${variant.relyingParty}`,\n    ],\n',
      '    appleTeamId: "5WGZKZGPQS",\n', 'replace'],
    ['        "Allow T3 Code to connect to T3 Code servers on your local network or tailnet.",',
      '        "Allow Rubato to reach the Rubato app on your Mac over your local network or tailnet.",', 'replace'],
    // Calls: a VoIP push wakes the app for CallKit (companion-ui's modules/rubato-call), the
    // call keeps its audio in the background, and thread alerts can arrive silently.
    ['      UIBackgroundModes: ["audio"],', '      UIBackgroundModes: ["audio", "voip", "remote-notification"],', 'replace'],
    ['      NSPhotoLibraryAddUsageDescription: "Allow T3 Code to save images to your photo library.",',
      '      NSPhotoLibraryAddUsageDescription: "Allow Rubato to save images to your photo library.",', 'replace'],
    // The share extension and widgets each need an app id and an app group of their own.
    ['    ...(isIosPersonalTeamBuild\n      ? [sharingPlugin]\n      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),', '    sharingPlugin,', 'replace'],
    ['      enabled: !isIosPersonalTeamBuild,\n      extensionBundleIdentifier', '      enabled: false,\n      extensionBundleIdentifier', 'replace'],
    ['    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],\n    "expo-web-browser",',
      '    // Rubato: no Clerk; the phone signs in to no T3 account.\n    "expo-web-browser",', 'replace'],
    ['        microphonePermission: "Allow T3 Code to use your microphone for voice input.",',
      '        microphonePermission:\n          "Rubato uses the microphone for calls with your companions and for dictation.",', 'replace'],
    ['        cameraPermission: "Allow T3 Code to access your camera so you can scan pairing QR codes.",',
      '        cameraPermission: "Allow Rubato to use your camera to scan the pairing QR code from your Mac.",', 'replace'],
    ['        image: variant.assets.splashIcon,\n        resizeMode: "contain",', '        image: RUBATO_ICON,\n        resizeMode: "contain",', 'replace'],
    ['          image: variant.assets.splashIcon,\n          backgroundColor: "#0a0a0a",', '          image: RUBATO_ICON,\n          backgroundColor: "#0a0a0a",', 'replace'],
    // Builds the targets/ folder's extensions (the notification service).
    ['    "./plugins/withAndroidGradleHeap.cjs",',
      '    "@bacons/apple-targets",\n    "./plugins/withAndroidGradleHeap.cjs",', 'replace'],
    // LiveKit's native setup for companion calls (deps-edits.mjs).
    ['    "./plugins/withIosCocoaPodsUuidCache.cjs",\n',
      '    "@livekit/react-native-expo-plugin",\n    [\n      "@config-plugins/react-native-webrtc",\n      {\n        cameraPermission: "Allow Rubato to use your camera to scan the pairing QR code from your Mac.",\n        microphonePermission:\n          "Rubato uses the microphone for calls with your companions and for dictation.",\n      },\n    ],\n    "./plugins/withIosCocoaPodsUuidCache.cjs",\n', 'replace'],
    ['    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),\n    "./plugins/withAndroidCleartextTraffic.cjs",',
      '    // Rubato: no widget extension.\n    "./plugins/withAndroidCleartextTraffic.cjs",', 'replace'],
    // Without the share extension and T3's relay, the JavaScript must not reach for either:
    // both check this flag (IncomingShareProvider, agent-awareness/capabilities).
    ['    iosPersonalTeamBuild: isIosPersonalTeamBuild,', '    iosPersonalTeamBuild: true,', 'replace'],
    ['    relay: {\n      url: repoEnv.T3CODE_RELAY_URL ?? null,\n    },\n    clerk: {\n      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,\n      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,\n    },',
      '    // Rubato: no T3 account and no T3 relay; the phone pairs with the Mac directly. Empty, not\n    // null: the public manifest would turn null into {}.\n    relay: {},\n    clerk: {},', 'replace'],
    ['    eas: {\n      projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",\n    },\n  },\n  owner: "pingdotgg",\n};',
      '  },\n};', 'replace'],
  ],

  // Companions first: the room list is the tab the app opens on.
  'apps/mobile/src/features/workspace/workspace-tabs-state.ts': [
    ['export type WorkspaceTab = "threads" | "pullRequests";', 'export type WorkspaceTab = "companions" | "threads" | "pullRequests";', 'replace'],
    ['    selectedTab: "threads",\n    selectionRevision: 0,\n    tabs: { threads: emptyTab(), pullRequests: emptyTab() },',
      '    selectedTab: "companions",\n    selectionRevision: 0,\n    tabs: { companions: emptyTab(), threads: emptyTab(), pullRequests: emptyTab() },', 'replace'],
  ],
  // T3's search tests start on the threads tab; Rubato opens on companions.
  'apps/mobile/src/features/workspace/workspace-tabs-state.test.ts': [
    ['import {\n  initialWorkspaceTabsState,\n  workspaceTabsReducer,\n  workspaceToolbarHeight,\n} from "./workspace-tabs-state";\n',
      'import {\n  initialWorkspaceTabsState as initialRubatoWorkspaceTabsState,\n  workspaceTabsReducer,\n  workspaceToolbarHeight,\n} from "./workspace-tabs-state";\n\n'
      + 'const initialWorkspaceTabsState = () => ({\n  ...initialRubatoWorkspaceTabsState(),\n  selectedTab: "threads" as const,\n});\n\n'
      + 'it("opens on the companions tab", () => {\n  expect(initialRubatoWorkspaceTabsState().selectedTab).toBe("companions");\n});\n', 'replace'],
  ],
  'apps/mobile/src/features/workspace/WorkspaceTabsContext.tsx': [
    ['useRef({ threads: 0, pullRequests: 0 })', 'useRef({ companions: 0, threads: 0, pullRequests: 0 })', 'replace'],
  ],
  'apps/mobile/src/features/workspace/WorkspaceNativeTabs.ios.tsx': [
    ['const COMPOSE_TAB = "compose";\n', 'const COMPOSE_TAB = "compose";\n'
      + 'const RUBATO_TAB_TITLES = { companions: "Companions", threads: "Threads", pullRequests: "Pulls" } as const;\n'
      + 'const RUBATO_TAB_LABELS = {\n  companions: "Companions",\n  threads: "Threads",\n  pullRequests: "Pull requests",\n} as const;\n', 'replace'],
    ['if (tab !== "threads" && tab !== "pullRequests") return;', 'if (tab !== "companions" && tab !== "threads" && tab !== "pullRequests") return;', 'replace'],
    ['{(["threads", "pullRequests"] as const).map((tab: WorkspaceTab) => (', '{(["companions", "threads", "pullRequests"] as const).map((tab: WorkspaceTab) => (', 'replace'],
    ['title={tab === "threads" ? "Threads" : "Pulls"}', 'title={RUBATO_TAB_TITLES[tab]}', 'replace'],
    ['tabBarItemAccessibilityLabel={tab === "threads" ? "Threads" : "Pull requests"}', 'tabBarItemAccessibilityLabel={RUBATO_TAB_LABELS[tab]}', 'replace'],
    ['              icon:\n                tab === "threads"\n                  ? { type: "sfSymbol", name: "text.bubble" }\n                  : { type: "templateSource", templateSource: PULL_REQUEST_ICON },\n              selectedIcon:\n                tab === "threads" ? { type: "sfSymbol", name: "text.bubble.fill" } : undefined,',
      '              icon:\n                tab === "companions"\n                  ? { type: "sfSymbol", name: "bubble.left.and.bubble.right" }\n                  : tab === "threads"\n                    ? { type: "sfSymbol", name: "chevron.left.forwardslash.chevron.right" }\n                    : { type: "templateSource", templateSource: PULL_REQUEST_ICON },\n              selectedIcon:\n                tab === "companions"\n                  ? { type: "sfSymbol", name: "bubble.left.and.bubble.right.fill" }\n                  : undefined,', 'replace'],
  ],
  'apps/mobile/src/features/workspace/WorkspaceSidebarTabs.ios.tsx': [
    ['          <Text modifiers={[tag("threads")]}>Threads</Text>', '          <Text modifiers={[tag("companions")]}>Companions</Text>\n'],
  ],
  'apps/mobile/src/features/workspace/WorkspaceRootScreen.tsx': [
    ['import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";\n',
      'import { CompanionListRouteScreen } from "../rubato-shell/companionSurface";\n'],
    ['const TAB_TITLES = {\n  threads: "Threads",', 'const TAB_TITLES = {\n  companions: "Companions",\n  threads: "Threads",', 'replace'],
    ['accessibilityLabel={`T3 Code, ${TAB_TITLES[state.selectedTab]}`}', 'accessibilityLabel={`Rubato, ${TAB_TITLES[state.selectedTab]}`}', 'replace'],
    ['            title="T3 Code"\n', '            title="Rubato"\n', 'replace'],
    ['{state.selectedTab === "threads" ? <HomeRouteScreen /> : <PullRequestsScreen />}',
      '{state.selectedTab === "companions" ? (\n            <CompanionListRouteScreen />\n          ) : state.selectedTab === "threads" ? (\n            <HomeRouteScreen />\n          ) : (\n            <PullRequestsScreen />\n          )}', 'replace'],
  ],
  // Companion conversations live in the Companions tab only (rubato-shell/companionThreads.ts).
  'apps/mobile/src/features/home/HomeRouteScreen.tsx': [
    ['import { buildHomeProjectScopes } from "./homeThreadList";\n',
      'import { buildHomeProjectScopes } from "./homeThreadList";\nimport { useWithoutCompanionThreads } from "../rubato-shell/companionThreads";\n', 'replace'],
    ['  const threads = useAtomValueWhileVisible(\n    environmentThreadShells.navigationThreadShellsAtom,\n    visible,\n  );',
      '  const allThreads = useAtomValueWhileVisible(\n    environmentThreadShells.navigationThreadShellsAtom,\n    visible,\n  );\n  const threads = useWithoutCompanionThreads(allThreads);', 'replace'],
  ],
  // Dictation goes through the Mac's voice service, as on the desktop (rubato-voice/).
  'apps/mobile/src/features/voice-input/VoiceInputProvider.tsx': [
    ['import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";\n',
      'import { savedConnectionsByIdAtom } from "../../state/use-remote-environment-registry";\nimport { createMacVoiceTranscriber, withMacVoiceFailure } from "../rubato-voice/macVoiceTranscriber";\n', 'replace'],
    ['    recorderRef.current = recorder;\n    sessionRef.current = new VoiceInputSession({',
      '    recorderRef.current = recorder;\n    const macTranscriber = createMacVoiceTranscriber(() =>\n      Object.values(registry.get(savedConnectionsByIdAtom)),\n    );\n    sessionRef.current = new VoiceInputSession({', 'replace'],
    ['      getTranscriber: getLocalVoiceTranscriber,', '      getTranscriber: () => macTranscriber,', 'replace'],
    ['          state: nextState,\n', '          state: withMacVoiceFailure(nextState),\n', 'replace'],
    ['    // Store screenshots show the dictation button even on simulators, whose\n    // on-device transcription is unavailable.\n    isAvailable: getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,',
      '    // Rubato: the Mac transcribes, so the button is always there; with no Mac paired,\n    // starting says so.\n    isAvailable: true,', 'replace'],
    ['import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";\n',
      '// Rubato: the showcase scene no longer decides whether dictation shows.\n', 'replace'],
  ],
  'apps/mobile/src/state/use-remote-environment-registry.ts': [
    ['const savedConnectionsByIdAtom = Atom.make((get) => {', 'export const savedConnectionsByIdAtom = Atom.make((get) => {', 'replace'],
  ],
  // A companion's message opens its room, and stays quiet while that room is open
  // (rubato-shell/companionNotifications.ts); thread alerts keep T3's routing.
  'apps/mobile/src/features/agent-awareness/notificationNavigation.ts': [
    ['import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";\n',
      'import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";\nimport {\n  COMPANION_ROOM_ON_SCREEN,\n  companionNotificationLink,\n  companionNotificationOnScreen,\n} from "../rubato-shell/companionNotifications";\n', 'replace'],
    ['  const deepLinkOnScreen = useRef<string | null>(null);\n',
      '  const deepLinkOnScreen = useRef<string | null>(null);\n  const pathnameOnScreen = useRef<string | null>(null);\n', 'replace'],
    ['    const thread = threadDeepLinkOnScreen(pathname);\n',
      '    pathnameOnScreen.current = pathname;\n    const thread = threadDeepLinkOnScreen(pathname);\n', 'replace'],
    ['        Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen.current)),',
      '        Promise.resolve(\n          companionNotificationOnScreen(notification.request.content.data, pathnameOnScreen.current)\n            ? COMPANION_ROOM_ON_SCREEN\n            : foregroundNotificationBehavior(notification, deepLinkOnScreen.current),\n        ),', 'replace'],
    ['    const handleResponse = (response: Notifications.NotificationResponse): void => {\n      routeAgentNotificationResponseOnce({',
      '    const handleResponse = (response: Notifications.NotificationResponse): void => {\n      const companionLink = companionNotificationLink(response.notification.request.content.data);\n      if (companionLink !== null) {\n        const id = response.notification.request.identifier;\n        if (handledResponseIds.current.has(id)) return;\n        handledResponseIds.current.add(id);\n        linkTo(companionLink);\n        return;\n      }\n      routeAgentNotificationResponseOnce({', 'replace'],
  ],
  // The companion list has nothing to search.
  'apps/mobile/src/features/workspace/WorkspaceToolbar.ios.tsx': [
    ['          headerSearchBarOptions:\n            NATIVE_LIQUID_GLASS_SUPPORTED || tab.searchMode !== "resting"',
      '          headerSearchBarOptions:\n            selectedTab !== "companions" &&\n            (NATIVE_LIQUID_GLASS_SUPPORTED || tab.searchMode !== "resting")', 'replace'],
  ],
  'apps/mobile/src/Stack.tsx': [
    ['import { ThreadRouteScreen } from "./features/threads/ThreadRouteScreen";\n',
      'import {\n  CompanionCallRouteScreen,\n  CompanionNamesSettingsRouteScreen,\n  CompanionRoomRouteScreen,\n} from "./features/rubato-shell/companionSurface";\n'],
    // The companions' names (Korean by default, renamable), among the other settings.
    ['    SettingsMicrophone: createNativeStackScreen({\n',
      '    SettingsCompanions: createNativeStackScreen({\n      screen: CompanionNamesSettingsRouteScreen,\n      linking: "companions",\n    }),\n'],
    ['    NotFound: createNativeStackScreen({\n      screen: NotFoundScreen,',
      '    // Rubato: a companion\'s room, pushed over the tabs like a thread.\n'
      + '    CompanionRoom: createNativeStackScreen({\n      screen: CompanionRoomRouteScreen,\n      linking: "companions/:companionId",\n      // The thread screen\'s bar; the room sets its own title (avatar over name).\n      options: GLASS_HEADER_OPTIONS,\n    }),\n'
      + '    // One call\'s full transcript, over the room.\n'
      + '    CompanionCall: createNativeStackScreen({\n      screen: CompanionCallRouteScreen,\n      linking: "companions/:companionId/calls/:callId",\n      options: {\n        ...FORM_SHEET_PRESENTATION_OPTIONS,\n        sheetAllowedDetents: [0.5, 0.92],\n        sheetGrabberVisible: true,\n        headerShown: false,\n      },\n    }),\n'],
    ['      options: { title: "About T3 Code" },', '      options: { title: "About Rubato" },', 'replace'],
  ],
  'apps/mobile/src/App.tsx': [
    ['import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";\n',
      'import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";\nimport { RubatoCallHost } from "./features/rubato-shell/companionSurface";\nimport { RubatoPushHost } from "./features/rubato-push";\n', 'replace'],
    // The call on screen and the ring of an open app, over every route; push tokens kept in line
    // with the relay and every paired Mac (features/rubato-push).
    ['                  <ThreadArrangementHost />\n', '                  <ThreadArrangementHost />\n                  <RubatoCallHost />\n                  <RubatoPushHost />\n', 'replace'],
    ['  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],',
      '  prefixes: [Linking.createURL("/"), "rubato://", "rubato-dev://", "rubato-preview://"],', 'replace'],
  ],

  // Themes: the five Rubato library themes the desktop offers (packages/shared rubatoThemes.ts,
  // reached through BUILT_IN_THEMES), Ocean first and by default; T3's standard palette is not offered.
  'apps/mobile/src/lib/mobileTheme.ts': [
    ['export const DEFAULT_MOBILE_THEME_ID = MOBILE_DEFAULT_THEME_ID;\n',
      'export const DEFAULT_MOBILE_THEME_ID = MOBILE_DEFAULT_THEME_ID;\n/** Rubato: a fresh install, or a saved theme this build lacks, shows Ocean, as the desktop does. */\nexport const RUBATO_DEFAULT_MOBILE_THEME_ID = "ocean" as const;\n', 'replace'],
    ['  { id: DEFAULT_MOBILE_THEME_ID, label: "T3 Code" },\n  { id: "material-you", label: "Material You" },',
      '  // Rubato: no "T3 Code" card; the desktop offers only its library themes.\n  { id: "material-you", label: "Material You" },', 'replace'],
    ['    ? (value as MobileThemeId)\n    : DEFAULT_MOBILE_THEME_ID;',
      '    ? (value as MobileThemeId)\n    : RUBATO_DEFAULT_MOBILE_THEME_ID;', 'replace'],
  ],
  // A scheme-only wake-up link (dictation keyboards) is Rubato's scheme now.
  'apps/mobile/src/lib/appLinking.ts': [
    ['!/^t3code(-dev|-preview)?:\\/*$/.test(url)', '!/^rubato(-dev|-preview)?:\\/*$/.test(url)', 'replace'],
  ],
  'apps/mobile/src/lib/appLinking.test.ts': [
    ['it.each(["t3code://", "t3code:///", "t3code-dev://", "t3code-preview://"])(', 'it.each(["rubato://", "rubato:///", "rubato-dev://", "rubato-preview://"])(', 'replace'],
  ],
  // Brand: Rubato's name where T3 drew its wordmark.
  'apps/mobile/src/components/CompactBrandTitle.tsx': [
    ['      accessibilityLabel={props.accessibilityLabel ?? "T3 Code, Threads"}', '      accessibilityLabel={props.accessibilityLabel ?? "Rubato"}', 'replace'],
    ['      <T3Wordmark colorClassName="accent-icon" height={Math.round(15 * scale)} />\n      <Text\n        allowFontScaling={props.allowFontScaling}\n        className="font-t3-medium text-foreground-muted"\n        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}\n      >\n        Code\n      </Text>',
      '      <Text\n        allowFontScaling={props.allowFontScaling}\n        className="font-t3-bold text-foreground"\n        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}\n      >\n        Rubato\n      </Text>', 'replace'],
    ['import { T3Wordmark } from "./T3Wordmark";\nimport { IPAD_HOME_TITLE_OFFSET }', '// Rubato: the name, not T3\'s wordmark.\nimport { IPAD_HOME_TITLE_OFFSET }', 'replace'],
  ],
  'apps/mobile/src/components/brandAssets.ts': [
    ['export const T3_CODE_BRAND_MARK_SOURCE =\n  appVariant === "development"\n    ? require("../../../../assets/dev/blueprint-ios-1024.png")\n    : appVariant === "preview"\n      ? require("../../../../assets/nightly/nightly-ios-1024.png")\n      : require("../../../../assets/prod/black-ios-1024.png");',
      '// Rubato: one mark for every variant (build-ios.sh writes it).\nvoid appVariant;\nexport const T3_CODE_BRAND_MARK_SOURCE = require("../../assets/rubato/icon.png");', 'replace'],
  ],
  'apps/mobile/src/components/BrandMark.tsx': [
    ['text-foreground">T3 Code</Text>', 'text-foreground">Rubato</Text>', 'replace'],
    ['            Mobile control surface for your live coding environments', '            Your companions and coding threads, from your Mac', 'replace'],
  ],
  // Legal links open Rubato's own page (store/site, published at rubato-app.pages.dev).
  'apps/mobile/src/features/settings/lib/legal-document-url.ts': [
    ['const DEFAULT_MARKETING_SITE_URL = "https://t3.codes";', 'const DEFAULT_MARKETING_SITE_URL = "https://rubato-app.pages.dev";', 'replace'],
  ],
  'apps/mobile/src/features/settings/lib/legal-document-url.test.ts': [
    ['    "https://t3.codes/legal",\n    "https://t3.codes/legal/",\n    "https://t3.codes/privacy-policy?source=app",\n    "https://t3.codes/terms-of-service#updates",\n    "https://t3.codes/security-policy",',
      '    "https://rubato-app.pages.dev/legal",\n    "https://rubato-app.pages.dev/legal/",\n    "https://rubato-app.pages.dev/privacy-policy?source=app",\n    "https://rubato-app.pages.dev/terms-of-service#updates",\n    "https://rubato-app.pages.dev/security-policy",', 'replace'],
    ['    "https://t3.codes/download",', '    "https://rubato-app.pages.dev/download",\n    "https://t3.codes/legal",', 'replace'],
  ],
  'apps/mobile/src/features/settings/SettingsRouteScreen.tsx': [
    ['label="About T3 Code"', 'label="About Rubato"', 'replace'],
    ['        <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />\n',
      '        <SettingsRow icon="person.2" label="Companions" target="SettingsCompanions" />\n'],
  ],
  'apps/mobile/src/features/settings/components/settings-sheet-targets.ts': [
    ['  | "SettingsKeyboard"\n', '  | "SettingsCompanions"\n'],
  ],
  'apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx': [
    ['<SettingsScreen title="About T3 Code">', '<SettingsScreen title="About Rubato">', 'replace'],
  ],
  'apps/mobile/src/features/settings/SettingsMicrophoneRouteScreen.tsx': [
    ['"Microphone access is off for T3 Code.', '"Microphone access is off for Rubato.', 'replace'],
  ],

  // Model logos: a Rubato model shows its vendor, not T3's OpenAI fallback.
  'apps/mobile/src/components/ProviderIcon.tsx': [
    ['import { getProviderClient } from "../lib/providerClients";\n',
      'import { getProviderClient } from "../lib/providerClients";\nimport { resolveRubatoGlyph } from "./rubatoModelGlyph";\nimport { RubatoVendorMark } from "./RubatoVendorMark";\n', 'replace'],
    ['  readonly iconUrl?: string | null | undefined;\n  readonly size?: number;\n};',
      '  readonly iconUrl?: string | null | undefined;\n  /** Rubato: the model slug, when the icon stands for one model of a multi-vendor provider. */\n  readonly model?: string | null | undefined;\n  readonly size?: number;\n};', 'replace'],
    ['export function ProviderIcon(props: ProviderIconProps) {',
      '/** Rubato: a rubato-pi model draws its vendor (rubatoModelGlyph.ts); every other driver is T3\'s. */\n'
      + 'export function ProviderIcon(props: ProviderIconProps) {\n'
      + '  const glyph = resolveRubatoGlyph(props.provider, props.model);\n'
      + '  const { themeAppearance } = useAppearancePreferences();\n'
      + '  if (glyph === null) return <T3ProviderIcon {...props} />;\n'
      + '  if (glyph.kind === "driver") return <T3ProviderIcon provider={glyph.driver} size={props.size} />;\n'
      + '  const mono = themeAppearance === "dark" ? "#e5e5e5" : "#171717";\n'
      + '  return <RubatoVendorMark color={mono} mark={glyph.mark} size={props.size ?? 16} />;\n'
      + '}\n\n'
      + 'function T3ProviderIcon(props: ProviderIconProps) {', 'replace'],
    ['export function ProviderInstanceIcon(props: {\n  readonly iconUrl?: string | null;\n',
      'export function ProviderInstanceIcon(props: {\n  readonly iconUrl?: string | null;\n  readonly model?: string | null;\n', 'replace'],
    ['<ProviderIcon iconUrl={props.iconUrl} provider={props.provider} size={props.size} />',
      '<ProviderIcon\n          iconUrl={props.iconUrl}\n          model={props.model}\n          provider={props.provider}\n          size={props.size}\n        />', 'replace'],
  ],
  'apps/mobile/src/features/threads/ThreadComposer.tsx': [
    ['iconUrl={currentModelOption?.providerIconUrl}\n', 'model={currentModelSelection.model}\n                            '],
  ],
  'apps/mobile/src/features/threads/NewTaskDraftScreen.tsx': [
    ['iconUrl={flow.selectedModelOption?.providerIconUrl}\n', 'model={flow.selectedModelOption?.selection.model}\n                            '],
  ],
  'apps/mobile/src/features/threads/thread-list-v2-items.tsx': [
    ['provider={providerInstance.driverKind}\n', 'model={thread.modelSelection.model}\n              '],
  ],
};
