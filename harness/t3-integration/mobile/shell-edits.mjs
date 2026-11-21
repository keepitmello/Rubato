// The Rubato iPhone app shell: T3's apps/mobile under Rubato's name and Apple team, with
// T3's cloud (Clerk login, T3 Connect relay, Expo updates and project) left out, the
// companions as the first tab, and each Rubato model drawn with its vendor's logo.
//
//   app.config.ts              name, bundle id com.keepitmello.rubato, team 5WGZKZGPQS,
//                              no Clerk plugin/associated domains, no OTA updates, no widget
//                              or share extensions (each needs its own app id and app group)
//   workspace tabs             companions | threads | usage; companions opens first. T3's pull
//                              request and issue tabs start hidden: the phone is not where PRs
//                              are read. A phone that saved its tabs before gets usage third once
//                              (rubato-shell/usageTabPlacement.ts)
//   Stack.tsx                  CompanionRoom route (companions/:companionId)
//   ProviderIcon.tsx           rubato-pi models: vendor glyph (rubatoModelGlyph.ts)
//
// The app icon and splash are PNGs, which overlays (text only) cannot carry: build-ios.sh
// writes apps/mobile/assets/rubato/ from assets/Rubato.png before prebuild.

export const shellOverlays = [
  'apps/mobile/src/i18n/rubatoKorean.test.ts',
  'apps/mobile/src/components/rubatoModelGlyph.ts',
  'apps/mobile/src/components/rubatoModelGlyph.test.ts',
  'apps/mobile/src/components/RubatoVendorMark.tsx',
  'apps/mobile/src/features/rubato-shell/companionSurface.tsx',
  'apps/mobile/src/features/rubato-shell/companionThreads.ts',
  'apps/mobile/src/features/rubato-shell/companionThreadFilter.ts',
  'apps/mobile/src/features/rubato-shell/companionThreadFilter.test.ts',
  'apps/mobile/src/features/rubato-voice/macLiveDictation.ts',
  'apps/mobile/src/features/rubato-voice/macVoiceFailures.ts',
  'apps/mobile/src/features/rubato-voice/macVoiceFailures.test.ts',
  'apps/mobile/src/features/rubato-shell/companionNotifications.ts',
  'apps/mobile/src/features/rubato-shell/companionNotifications.test.ts',
  'apps/mobile/targets/notification-service/expo-target.config.js',
  'apps/mobile/src/features/rubato-shell/macRestart.ts',
  'apps/mobile/src/features/rubato-shell/macRestart.test.ts',
  'apps/mobile/src/features/rubato-shell/MacRestartSection.tsx',
  'apps/mobile/src/features/rubato-shell/companionTabStatus.ts',
  'apps/mobile/src/features/rubato-shell/companionTabStatus.test.ts',
  'apps/mobile/src/features/rubato-shell/tabSwipe.ts',
  'apps/mobile/src/features/rubato-shell/tabSwipe.test.ts',
  'apps/mobile/src/features/rubato-shell/WorkspaceTabSwipe.tsx',
  'apps/mobile/src/features/rubato-shell/usageTabPlacement.ts',
  'apps/mobile/src/features/rubato-shell/usageTabPlacement.test.ts',
];

const RUBATO_ICON = './assets/rubato/icon.png';

export const shellEdits = {
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
      + `const RUBATO_ICON = "${RUBATO_ICON}";\n`
      + '// Rubato: the notification service extension and the entitlements it needs (Communication\n'
      + '// Notifications, App Group). Off until the Apple account enables both capabilities on the\n'
      + '// app ids; build-ios.sh sets RUBATO_IOS_NOTIFICATION_EXTENSION=1 once they exist.\n'
      + 'const RUBATO_NOTIFICATION_EXTENSION = process.env.RUBATO_IOS_NOTIFICATION_EXTENSION === "1";\n'
      + '// Rubato: the widget extension that draws the Live Activity card (expo-widgets). It and the app share\n'
      + '// the App Group group.com.keepitmello.rubato, which only the Apple account can put on the app ids\n'
      + '// com.keepitmello.rubato and com.keepitmello.rubato.widgets. Turning it on changes the native\n'
      + '// fingerprint: a TestFlight build, and every update after it, carries it.\n'
      + 'const RUBATO_WIDGETS = true;\n\n'],
    ['  slug: "t3-code",', '  slug: "rubato",', 'replace'],
    // Rubato's own version line; build-ios.sh stamps the build number.
    ['  version: repoEnv.T3CODE_MOBILE_VERSION ?? "2.3.0",', '  version: "1.0.0",', 'replace'],
    ['  icon: variant.assets.appIcon,\n  userInterfaceStyle', '  icon: RUBATO_ICON,\n  userInterfaceStyle', 'replace'],
    // T3's Expo project serves T3's JavaScript; a Rubato binary loads only Rubato's (EAS Update,
    // mobile/update-ios.sh), from the production channel.
    ['  updates: {\n    enabled: repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",\n    url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",\n    checkAutomatically: "ON_LOAD",\n    fallbackToCacheTimeout: 0,\n  },',
      '  updates: {\n    // Rubato\'s own Expo project (keepitmello1/rubato): JavaScript sent with mobile/update-ios.sh.\n    url: "https://u.expo.dev/a877f54c-97e5-47f0-83a2-2fc36b7c0694",\n    checkAutomatically: "ON_LOAD",\n    fallbackToCacheTimeout: 0,\n    requestHeaders: { "expo-channel-name": "production" },\n  },', 'replace'],
    ['    icon: variant.assets.iosIcon,', '    icon: RUBATO_ICON,', 'replace'],
    // Companion messages as Communication Notifications, and the App Group the app shares with
    // its notification service extension (targets/notification-service) and CallKit.
    ['      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],\n',
      '      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],\n      ...(RUBATO_NOTIFICATION_EXTENSION\n        ? {\n            "com.apple.developer.usernotifications.communication": true,\n            "com.apple.security.application-groups": ["group.com.keepitmello.rubato"],\n          }\n        : {}),\n', 'replace'],
    ['      NSAppTransportSecurity: {\n        NSAllowsArbitraryLoads: true,\n      },\n',
      '      NSAppTransportSecurity: {\n        NSAllowsArbitraryLoads: true,\n      },\n      NSUserActivityTypes: ["INSendMessageIntent"],\n', 'replace'],
    // Rubato's team; Clerk's applinks/webcredentials domain belongs to T3's login, the hosted app
    // domain to T3's site.
    ['    appleTeamId: "ARK85ZXQ4Z",\n    associatedDomains: [\n      `applinks:${variant.relyingParty}`,\n      `webcredentials:${variant.relyingParty}`,\n      `applinks:${HOSTED_APP_HOST}`,\n    ],\n',
      '    appleTeamId: "5WGZKZGPQS",\n', 'replace'],
    ['        "Allow T3 Code to connect to T3 Code servers on your local network or tailnet.",',
      '        "Allow Rubato to reach the Rubato app on your Mac over your local network or tailnet.",', 'replace'],
    // Calls: a VoIP push wakes the app for CallKit (companion-ui's modules/rubato-call), the
    // call keeps its audio in the background, and thread alerts can arrive silently.
    ['      UIBackgroundModes: ["audio"],', '      UIBackgroundModes: ["audio", "voip", "remote-notification"],', 'replace'],
    ['      NSPhotoLibraryAddUsageDescription: "Allow T3 Code to save images to your photo library.",',
      '      NSPhotoLibraryAddUsageDescription: "Allow Rubato to save images to your photo library.",', 'replace'],
    // The share extension needs an app id and an app group of its own.
    ['    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),',
      '    ...(RUBATO_WIDGETS ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),', 'replace'],
    ['    ...(isIosPersonalTeamBuild\n      ? [sharingPlugin]\n      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),', '    sharingPlugin,', 'replace'],
    ['      enabled: !isIosPersonalTeamBuild,\n      extensionBundleIdentifier', '      enabled: false,\n      extensionBundleIdentifier', 'replace'],
    ['    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],\n    "expo-web-browser",',
      '    // Rubato: no Clerk; the phone signs in to no T3 account.\n    "expo-web-browser",', 'replace'],
    ['        microphonePermission: "Allow T3 Code to use your microphone for voice input.",\n        recordAudioAndroid: true,',
      '        microphonePermission:\n          "Rubato uses the microphone for calls with your companions and for dictation.",\n        recordAudioAndroid: true,', 'replace'],
    ['        // `false` makes this plugin add RECORD_AUDIO to blockedPermissions, breaking Android dictation.\n        microphonePermission: "Allow T3 Code to use your microphone for voice input.",',
      '        // `false` makes this plugin add RECORD_AUDIO to blockedPermissions, breaking Android dictation.\n        microphonePermission:\n          "Rubato uses the microphone for calls with your companions and for dictation.",', 'replace'],
    ['        cameraPermission: "Allow T3 Code to access your camera so you can scan pairing QR codes.",',
      '        cameraPermission: "Allow Rubato to use your camera to scan the pairing QR code from your Mac and to take a companion\'s picture.",', 'replace'],
    ['        image: variant.assets.splashIcon,\n        resizeMode: "contain",', '        image: RUBATO_ICON,\n        resizeMode: "contain",', 'replace'],
    ['          image: variant.assets.splashIcon,\n          backgroundColor: "#0a0a0a",', '          image: RUBATO_ICON,\n          backgroundColor: "#0a0a0a",', 'replace'],
    // Builds the targets/ folder's extensions (the notification service).
    ['    "./plugins/withAndroidGradleHeap.cjs",',
      '    ...(RUBATO_NOTIFICATION_EXTENSION ? ["@bacons/apple-targets"] : []),\n    "./plugins/withAndroidGradleHeap.cjs",', 'replace'],
    // LiveKit's native setup for companion calls (deps-edits.mjs).
    ['    "./plugins/withIosCocoaPodsUuidCache.cjs",\n',
      '    "@livekit/react-native-expo-plugin",\n    [\n      "@config-plugins/react-native-webrtc",\n      {\n        cameraPermission: "Allow Rubato to use your camera to scan the pairing QR code from your Mac and to take a companion\'s picture.",\n        microphonePermission:\n          "Rubato uses the microphone for calls with your companions and for dictation.",\n      },\n    ],\n    "./plugins/withIosCocoaPodsUuidCache.cjs",\n', 'replace'],
    // Without the share extension and T3's relay, the JavaScript must not reach for either:
    // both check this flag (IncomingShareProvider, agent-awareness/capabilities).
    ['    iosPersonalTeamBuild: isIosPersonalTeamBuild,',
      '    iosPersonalTeamBuild: true,\n    // Whether this binary carries the Live Activity card (rubato-push/liveActivity.ts reads it).\n    ...(RUBATO_WIDGETS ? { rubatoLiveActivity: true } : {}),', 'replace'],
    ['    relay: {\n      url: repoEnv.T3CODE_RELAY_URL ?? null,\n    },\n    clerk: {\n      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,\n      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,\n    },',
      '    // Rubato: no T3 account and no T3 relay; the phone pairs with the Mac directly. Empty, not\n    // null: the public manifest would turn null into {}.\n    relay: {},\n    clerk: {},', 'replace'],
    ['    eas: {\n      projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",\n      observe: { endpointUrl: observeEndpointUrl },\n    },\n  },\n  owner: "pingdotgg",',
      '    eas: {\n      projectId: "a877f54c-97e5-47f0-83a2-2fc36b7c0694",\n      observe: { endpointUrl: observeEndpointUrl },\n    },\n  },\n  owner: "keepitmello1",', 'replace'],
  ],

  // Companions first: the room list is the tab the app opens on, and a room belongs to it.
  'apps/mobile/src/features/layout/workspace/workspace-tabs-state.ts': [
    ["export function initialWorkspaceTabsState(\n  selectedTab: WorkspaceTab = \"threads\",\n)",
      "export function initialWorkspaceTabsState(\n  selectedTab: WorkspaceTab = \"companions\",\n)", 'replace'],
    ["    tabs: {\n      threads: emptyTab(),",
      "    tabs: {\n      companions: emptyTab(),\n      threads: emptyTab(),", 'replace'],
    ["  if (routeName === \"Issue\") return \"issues\";\n",
      "  // Rubato: a companion's room and call belong to the Companions tab.\n  if (routeName?.startsWith(\"Companion\")) return \"companions\";\n"],
  ],
  // The Companions tab has no page beside its list on a wide window.
  'apps/mobile/src/features/layout/workspace/workspace-tab-navigation.ts': [
    ["    options.columns && tab !== \"usage\"\n",
      "    options.columns && tab !== \"usage\" && tab !== \"companions\"\n", 'replace'],
  ],
  // T3's tab tests start on Threads; Rubato opens on Companions and keeps a saved tab order.
  'apps/mobile/src/features/layout/workspace/workspace-tabs-state.test.ts': [
    ["import {\n  initialWorkspaceTabsState,\n  workspaceTabsReducer,\n",
      "import {\n  initialWorkspaceTabsState as initialRubatoWorkspaceTabsState,\n  workspaceTabsReducer,\n", 'replace'],
    ["} from \"./workspace-tabs-state\";\n",
      "} from \"./workspace-tabs-state\";\n\nconst initialWorkspaceTabsState = (selectedTab: WorkspaceTab = \"threads\") =>\n  initialRubatoWorkspaceTabsState(selectedTab);\n", 'replace'],
    ["  it(\"keeps the registered defaults while customization is unavailable\", () => {\n    expect(resolveWorkspaceTabOrder(undefined)).toEqual([\n      \"threads\",\n      \"pullRequests\",\n      \"issues\",\n      \"usage\",\n    ]);\n    expect(resolveWorkspaceTabOrder([\"home\", \"usage\", \"issues\", \"threads\"])).toEqual(\n      resolveWorkspaceTabOrder(undefined),\n    );\n  });",
      "  it(\"opens on Companions, which leads the default order, and keeps a saved order\", () => {\n    expect(initialRubatoWorkspaceTabsState().selectedTab).toBe(\"companions\");\n    expect(resolveWorkspaceTabOrder(undefined)).toEqual([\n      \"companions\",\n      \"threads\",\n      \"usage\",\n      \"pullRequests\",\n      \"issues\",\n    ]);\n    expect(resolveWorkspaceTabOrder([\"home\", \"usage\", \"issues\", \"threads\"])).toEqual([\n      \"usage\",\n      \"issues\",\n      \"threads\",\n      \"companions\",\n      \"pullRequests\",\n    ]);\n  });", 'replace'],
  ],
  // T3's tab-order tests, with Companions first, Usage third, and pull requests and issues hidden by default.
  'apps/mobile/src/features/layout/workspace/navigation-tab-order.test.ts': [
    ["    expect(navigationCustomizationAvailable()).toBe(false);\n",
      "    // Rubato hides some tabs by default, so its Navigation page is always there.\n    expect(navigationCustomizationAvailable()).toBe(true);\n", 'replace'],
    ["    ).toEqual([\"usage\", \"threads\", \"pullRequests\", \"issues\"]);",
      "    ).toEqual([\"usage\", \"companions\", \"threads\", \"pullRequests\", \"issues\"]);", 'replace'],
    ["    expect(visibleNavigationTabs()).toEqual(NAVIGATION_TAB_ORDER);\n",
      "    expect(visibleNavigationTabs()).toEqual([\"companions\", \"threads\", \"usage\"]);\n    expect(visibleNavigationTabs(undefined, [])).toEqual(NAVIGATION_TAB_ORDER.slice(0, 4));\n    expect(overflowNavigationTabs(undefined, [])).toEqual([\"issues\"]);\n", 'replace'],
    ["    expect(selectedNavigationTab(undefined, \"usage\", false)).toBe(\"usage\");\n",
      "    expect(selectedNavigationTab(undefined, \"usage\", false)).toBe(\"usage\");\n    expect(selectedNavigationTab(undefined, \"pullRequests\", false)).toBe(\"settings\");\n    expect(selectedNavigationTab(undefined, \"pullRequests\", false, [])).toBe(\"pullRequests\");\n    expect(selectedNavigationTab(undefined, \"issues\", false, [])).toBe(\"settings\");\n", 'replace'],
    ["    expect(enabledNavigationTabs(order, hidden)).toEqual([\"threads\", \"pullRequests\", \"issues\"]);",
      "    expect(enabledNavigationTabs(order, hidden)).toEqual([\n      \"companions\",\n      \"threads\",\n      \"pullRequests\",\n      \"issues\",\n    ]);", 'replace'],
    ["    expect(resolveSelectedNavigationTab(undefined, [\"threads\"], \"threads\")).toBe(\"pullRequests\");",
      "    expect(resolveSelectedNavigationTab(undefined, [\"threads\"], \"threads\")).toBe(\"companions\");", 'replace'],
    ["  it(\"falls back when the selected section is hidden, including when all are hidden\", () => {",
      "  it(\"starts with pull requests and issues hidden until the user shows them\", () => {\n    expect(enabledNavigationTabs()).toEqual([\"companions\", \"threads\", \"usage\"]);\n    expect(toggleNavigationTabVisibility(undefined, \"issues\")).toEqual([\"pullRequests\"]);\n    expect(toggleNavigationTabVisibility(undefined, \"usage\")).toEqual([\"pullRequests\", \"issues\", \"usage\"]);\n  });\n\n  it(\"falls back when the selected section is hidden, including when all are hidden\", () => {", 'replace'],
  ],
  'apps/mobile/src/features/layout/workspace/WorkspaceTabsContext.tsx': [
    ["  const scrollOffsets: Record<WorkspaceSearchTab, number> = {\n    threads: 0,",
      "  const scrollOffsets: Record<WorkspaceSearchTab, number> = {\n    companions: 0,\n    threads: 0,", 'replace'],
  ],
  // The tab order: Companions, Threads, Usage. Pull requests and issues start hidden, as the
  // phone did not show them, and the Navigation settings page turns each one on.
  'apps/mobile/src/features/layout/workspace/navigation-tab-order.ts': [
    ["export const NAVIGATION_TAB_ORDER = [\"threads\", \"pullRequests\", \"issues\", \"usage\"] as const;",
      "export const NAVIGATION_TAB_ORDER = [\n  \"companions\",\n  \"threads\",\n  \"usage\",\n  \"pullRequests\",\n  \"issues\",\n] as const;", 'replace'],
    ["  registeredSections: number = NAVIGATION_TAB_ORDER.length - 1,\n",
      "  // Rubato: some tabs start hidden (RUBATO_HIDDEN_TABS), so the page that shows them is always there.\n  registeredSections: number = NAVIGATION_TAB_ORDER.length,\n", 'replace'],
    ["  threads: msg(\"Threads\", { $context: \"navigation tab, list of chat threads\" }),\n",
      "  companions: msg(\"Companions\", { $context: \"navigation tab, rooms of the companions\" }),\n"],
    ["export function resolveHiddenNavigationTabs(saved?: readonly unknown[]): readonly NavigationTab[] {\n  return [...new Set(saved?.filter(isNavigationTab) ?? [])];",
      "/** Rubato: the tabs a phone that never chose shows hidden. */\nconst RUBATO_HIDDEN_TABS: readonly NavigationTab[] = [\"pullRequests\", \"issues\"];\n\nexport function resolveHiddenNavigationTabs(saved?: readonly unknown[]): readonly NavigationTab[] {\n  return [...new Set(saved?.filter(isNavigationTab) ?? RUBATO_HIDDEN_TABS)];", 'replace'],
  ],
  // Threads keep their name (not "Chats", which reads as the companions) and a code glyph.
  'apps/mobile/src/features/layout/workspace/navigation-tabs.ts': [
    ["        threads: msg(\"Chats\", { $context: \"navigation tab, list of chat threads\" }),\n",
      "        // Rubato: Threads keep their name; \"Chats\" would read as the companions.\n", 'replace'],
    ["export const NAVIGATION_TAB_ICONS = {\n  threads: \"text.bubble\",",
      "export const NAVIGATION_TAB_ICONS = {\n  companions: \"bubble.left.and.bubble.right\",\n  threads: \"chevron.left.forwardslash.chevron.right\",", 'replace'],
  ],
  // A phone that saved its tabs before Usage became the third keeps them over the defaults; the first
  // load after moves Usage there once and remembers it did (rubato-shell/usageTabPlacement.ts).
  'apps/mobile/src/persistence/mobile-preferences.ts': [
    ['import * as MobileDatabase from "./mobile-database";\n',
      'import { placeUsageTab } from "../features/rubato-shell/usageTabPlacement";\n'],
    ['  readonly hiddenNavigationTabs?: readonly string[];\n  /** Whether pull requests or issues last held',
      '  readonly hiddenNavigationTabs?: readonly string[];\n  /** Rubato: Usage was moved to the third tab once (usageTabPlacement.ts). */\n  readonly rubatoUsageTabPlaced?: boolean;\n  /** Whether pull requests or issues last held',
      'replace'],
    ['    hiddenNavigationTabs?: readonly string[];\n    sharedSlotTab?: "pullRequests" | "issues";',
      '    hiddenNavigationTabs?: readonly string[];\n    rubatoUsageTabPlaced?: boolean;\n    sharedSlotTab?: "pullRequests" | "issues";',
      'replace'],
    ['  if (parsed.sharedSlotTab === "pullRequests" || parsed.sharedSlotTab === "issues") {',
      '  // Rubato: Usage became the third tab; a phone with saved tabs gets it there once.\n  if (parsed.rubatoUsageTabPlaced !== true) Object.assign(preferences, placeUsageTab(preferences));\n  preferences.rubatoUsageTabPlaced = true;\n\n'],
  ],
  // T3's storage tests are about storage: the one-time Usage placement above has its own tests
  // (usageTabPlacement.test.ts), so here it moves nothing and its flag is left out of the result.
  'apps/mobile/src/lib/storage.test.ts': [
    ['import { loadPreferences, savePreferencesPatch } from "../persistence/imperative";\n',
      'import { loadPreferences as loadSavedPreferences, savePreferencesPatch } from "../persistence/imperative";\n\n'
      + 'vi.mock("../features/rubato-shell/usageTabPlacement", () => ({ placeUsageTab: () => ({}) }));\n'
      + 'const loadPreferences = async () => {\n'
      + '  const { rubatoUsageTabPlaced: _placed, ...preferences } = await loadSavedPreferences();\n'
      + '  return preferences;\n'
      + '};\n', 'replace'],
  ],
  // The phone's floating tab picker draws its tabs natively, by name.
  'apps/mobile/modules/t3-native-controls/ios/T3SidebarTabBarView.swift': [
    ["    let labels = [\"threads\": \"Chats\", \"pullRequests\": \"PRs\",",
      "    let labels = [\"companions\": \"Companions\", \"threads\": \"Threads\", \"pullRequests\": \"PRs\",", 'replace'],
    ["    let symbols = [\"threads\": \"text.bubble\",",
      "    let symbols = [\"companions\": \"bubble.left.and.bubble.right\", \"threads\": \"chevron.left.forwardslash.chevron.right\",", 'replace'],
    ["      if tab == \"threads\" { item.selectedImage = tabIcon(UIImage(systemName: \"text.bubble.fill\")) }",
      "      if tab == \"companions\" { item.selectedImage = tabIcon(UIImage(systemName: \"bubble.left.and.bubble.right.fill\")) }", 'replace'],
  ],
  'apps/mobile/src/features/layout/workspace/WorkspaceNativeTabs.ios.tsx': [
    ["                    !settings && tab === \"threads\"\n                      ? { type: \"sfSymbol\", name: \"text.bubble.fill\" }",
      "                    !settings && tab === \"companions\"\n                      ? { type: \"sfSymbol\", name: \"bubble.left.and.bubble.right.fill\" }", 'replace'],
  ],
  'apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.tsx': [
    ["import { HomeRouteScreen } from \"../../home/HomeRouteScreen\";\n",
      "import { CompanionListRouteScreen } from \"../../rubato-shell/companionSurface\";\nimport { WorkspaceTabSwipe } from \"../../rubato-shell/WorkspaceTabSwipe\";\n"],
    ["gt(\"{product}, {title}\", { product: \"T3 Code\", title: tabTitle })",
      "gt(\"{product}, {title}\", { product: \"Rubato\", title: tabTitle })", 'replace'],
    // The Companions tab's title leaves out the thread sync (rubato-shell/companionTabStatus.ts).
    ["        maxWidth={maxWidth}\n        onPress={props.onOpenEnvironments}\n",
      "        threadSync={settingsOpen || state.selectedTab !== \"companions\"}\n"],
    // A horizontal swipe on the tab root moves between Companions and Threads, as the tab bar does
    // (rubato-shell/tabSwipe.ts). Only on the phone's tabs, and not while a list searches.
    ["        <SafeAreaInsetsContext value={compactTabs ? { ...insets, bottom: 0 } : insets}>\n",
      "        <WorkspaceTabSwipe\n          tab={state.selectedTab}\n          enabled={\n            (systemTabBar || compactTabs) &&\n            !sidebarNavigation &&\n            !settingsOpen &&\n            tab.searchMode === \"resting\"\n          }\n          onSelect={(next) => workspace.dispatch({ type: \"select\", tab: next })}\n        >\n"],
    ["        </SafeAreaInsetsContext>\n        {deviceType !== \"pad\" && deviceType !== \"phone\" && sidebarPicker ? (",
      "        </SafeAreaInsetsContext>\n        </WorkspaceTabSwipe>\n        {deviceType !== \"pad\" && deviceType !== \"phone\" && sidebarPicker ? (", 'replace'],
    ["          ) : state.selectedTab === \"threads\" ? (\n            <HomeRouteScreen />",
      "          ) : state.selectedTab === \"companions\" ? (\n            <CompanionListRouteScreen />\n          ) : state.selectedTab === \"threads\" ? (\n            <HomeRouteScreen />", 'replace'],
  ],
  // A title that leaves out the thread sync, for the Companions tab (rubato-shell/companionTabStatus.ts).
  'apps/mobile/src/features/home/WorkspaceConnectionTitle.tsx': [
    ["import { useWorkspaceState } from \"../../state/workspace\";\n",
      "import { useWorkspaceState } from \"../../state/workspace\";\nimport { withoutThreadSync } from \"../rubato-shell/companionTabStatus\";\n", 'replace'],
    ["export function WorkspaceConnectionTitle(props: {\n",
      "/**\n * Rubato: the shared status, or for a title that leaves out the thread sync, its own label once\n * the shared one shows (so it keeps the shared delay and fade).\n */\nfunction useRubatoConnectionStatus(\n  shown: ConnectionStatus | null,\n  threadSync = true,\n): ConnectionStatus | null {\n  const { state } = useWorkspaceState();\n  const m = useMessages();\n  if (threadSync || shown === null) return shown;\n  const own = workspaceConnectionStatusPresentation(withoutThreadSync(state), m);\n  return own === null ? null : { ...shown, ...own };\n}\n\n"],
    ["  readonly statusOffset?: number;\n  readonly maxWidth?: number;\n}) {\n  const status = use(ConnectionStatusContext);",
      "  readonly statusOffset?: number;\n  readonly maxWidth?: number;\n  /** Rubato: false leaves \"Syncing threads...\" out, for a surface the thread list does not feed. */\n  readonly threadSync?: boolean;\n}) {\n  const status = useRubatoConnectionStatus(use(ConnectionStatusContext), props.threadSync);", 'replace'],
  ],
  // Companion conversations live in the Companions tab only (rubato-shell/companionThreads.ts).
  'apps/mobile/src/features/home/HomeRouteScreen.tsx': [
    ["import { useHomeListOptions } from \"./home-list-options\";\n",
      "import { useWithoutCompanionThreads } from \"../rubato-shell/companionThreads\";\n"],
    ["  const threads = useLaunchingThreads(\n    useAtomValueWhileVisible(steadyNavigationThreadShellsAtom, visible),\n  );",
      "  const threads = useWithoutCompanionThreads(\n    useLaunchingThreads(useAtomValueWhileVisible(steadyNavigationThreadShellsAtom, visible)),\n  );", 'replace'],
  ],
  // Dictation is live, as on the desktop, unless a voice route is chosen in Settings: the Mac mints
  // a one-time key and the microphone streams to OpenAI over WebRTC (rubato-voice/macLiveDictation.ts).
  // A chosen route (an environment or a cloud key) keeps T3's recorder and transcriber.
  'apps/mobile/src/features/voice-input/VoiceInputProvider.tsx': [
    ["import { getLocalVoiceTranscriber } from \"../../native/voiceTranscription\";\n",
      "import { getLocalVoiceTranscriber } from \"../../native/voiceTranscription\";\nimport { savedConnectionsByIdAtom } from \"../../state/use-remote-environment-registry\";\nimport { createMacLiveDictation } from \"../rubato-voice/macLiveDictation\";\n", 'replace'],
    ["  if (route) return route.transcriber !== null;\n  const transcriber = get(localVoiceTranscriberAtom);\n  return transcriber !== null && transcriber !== \"checking\";",
      "  if (route) return route.transcriber !== null;\n  // Rubato: the Mac transcribes, so the button is always there; with no Mac paired, starting says so.\n  return true;", 'replace'],
    ["  const recorder = createLazyVoiceRecorder({\n",
      "  const upstreamRecorder = createLazyVoiceRecorder({\n", 'replace'],
    ["  const session: VoiceInputSession = new VoiceInputSession({\n    recorder,\n    getTranscriber: () => {\n      const route = registry.get(voiceRouteAtom);\n      if (route) return route.transcriber;\n      const transcriber = registry.get(localVoiceTranscriberAtom);\n      return transcriber === \"checking\" ? null : transcriber;\n    },\n    requestPermission: permission.requestPermission,\n    configureRecording: async () => {\n",
      "  const live = createMacLiveDictation(\n    () => Object.values(registry.get(savedConnectionsByIdAtom)),\n    (status) => session.controller.handleRecorderStatus(status),\n  );\n  const routed = () => registry.get(voiceRouteAtom) !== null;\n  const recorder = {\n    get uri() {\n      return routed() ? upstreamRecorder.uri : live.recorder.uri;\n    },\n    prepareToRecordAsync: (signal?: AbortSignal) =>\n      routed() ? upstreamRecorder.prepareToRecordAsync(signal) : live.recorder.prepareToRecordAsync(),\n    record: (options: { readonly forDuration: number }) =>\n      routed() ? upstreamRecorder.record(options) : live.recorder.record(options),\n    stop: () => (routed() ? upstreamRecorder.stop() : live.recorder.stop()),\n    getStatus: () => (routed() ? upstreamRecorder.getStatus() : live.recorder.getStatus()),\n    release: () => upstreamRecorder.release(),\n  };\n  const session: VoiceInputSession = new VoiceInputSession({\n    recorder,\n    getTranscriber: () => {\n      const route = registry.get(voiceRouteAtom);\n      return route ? route.transcriber : live.transcriber;\n    },\n    // The Mac's key is minted while the microphone permission is checked.\n    requestPermission: () => {\n      if (!routed()) live.warm();\n      return permission.requestPermission();\n    },\n    configureRecording: async () => {\n      // WebRTC sets up and releases the audio session itself; T3's setup would take it over.\n      if (!routed()) return;\n", 'replace'],
    ["    deleteRecording: (uri) => new File(uri).delete(),",
      "    deleteRecording: (uri) =>\n      uri.startsWith(\"live:\") ? live.deleteRecording(uri) : new File(uri).delete(),", 'replace'],
  ],
  // A companion's message opens its room, and stays quiet while that room is open
  // (rubato-shell/companionNotifications.ts); thread alerts keep T3's routing.
  'apps/mobile/src/features/agent-awareness/notificationNavigation.ts': [
    ["import { consumeLastAgentNotificationResponse } from \"./notificationResponseConsumer\";\n",
      "import { consumeLastAgentNotificationResponse } from \"./notificationResponseConsumer\";\nimport {\n  COMPANION_ROOM_ON_SCREEN,\n  companionNotificationLink,\n  companionNotificationOnScreen,\n} from \"../rubato-shell/companionNotifications\";\n", 'replace'],
    ["let deepLinkOnScreen: string | null = null;\n",
      "let deepLinkOnScreen: string | null = null;\nlet pathnameOnScreen: string | null = null;\n", 'replace'],
    ["  deepLinkOnScreen = threadDeepLinkOnScreen(pathname);\n",
      "  pathnameOnScreen = pathname;\n  deepLinkOnScreen = threadDeepLinkOnScreen(pathname);\n", 'replace'],
    ["      Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen)),",
      "      Promise.resolve(\n        companionNotificationOnScreen(notification.request.content.data, pathnameOnScreen)\n          ? COMPANION_ROOM_ON_SCREEN\n          : foregroundNotificationBehavior(notification, deepLinkOnScreen),\n      ),", 'replace'],
    ["  const handleResponse = (response: Notifications.NotificationResponse): void => {\n    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });",
      "  const handleResponse = (response: Notifications.NotificationResponse): void => {\n    const companionLink = companionNotificationLink(response.notification.request.content.data);\n    if (companionLink !== null) {\n      const id = response.notification.request.identifier;\n      if (handledResponseIds.has(id)) return;\n      handledResponseIds.add(id);\n      navigate(companionLink);\n      return;\n    }\n    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });", 'replace'],
  ],
  // The companion list has nothing to search.
  'apps/mobile/src/features/layout/workspace/WorkspaceToolbar.tsx': [
    ["  const searchLabel = m(SEARCH_LABELS[selectedTab === \"usage\" ? \"threads\" : selectedTab]);",
      "  const searchLabel = m(\n    SEARCH_LABELS[selectedTab === \"usage\" || selectedTab === \"companions\" ? \"threads\" : selectedTab],\n  );", 'replace'],
    ["  const searchVisible = foldedSearch\n    ? tab.searchMode !== \"resting\"\n    : deviceType !== \"duo-unfolded\" || primaryColumn?.presented !== false;",
      "  const searchVisible =\n    selectedTab !== \"companions\" &&\n    (foldedSearch\n      ? tab.searchMode !== \"resting\"\n      : deviceType !== \"duo-unfolded\" || primaryColumn?.presented !== false);", 'replace'],
  ],
  'apps/mobile/src/Stack.tsx': [
    ["import { McpAppFullscreenScreen } from \"./features/threads/McpAppFullscreenScreen\";\n",
      "import {\n  CompanionAvatarCropRouteScreen,\n  CompanionCallRouteScreen,\n  CompanionNamesSettingsRouteScreen,\n  CompanionPicturesRouteScreen,\n  CompanionProfileRouteScreen,\n  CompanionRoomRouteScreen,\n} from \"./features/rubato-shell/companionSurface\";\n"],
    // The companions' names (Korean by default, renamable), among the other settings.
    ["  SettingsNotifications: msg(\"Notifications\"),\n",
      "  SettingsCompanions: msg(\"Companions\"),\n"],
    ["  SettingsNotifications: createNativeStackScreen({\n",
      "  SettingsCompanions: createNativeStackScreen({\n    screen: CompanionNamesSettingsRouteScreen,\n    linking: \"settings/companions\",\n    options: settingsPage(),\n  }),\n"],
    ["    NotFound: createNativeStackScreen({\n      screen: NotFoundScreen,",
      "    // Rubato: a companion's room, pushed over the tabs like a thread; it sets its own title\n    // (avatar over name).\n    CompanionRoom: createNativeStackScreen({\n      screen: CompanionRoomRouteScreen,\n      linking: \"companions/:companionId\",\n      options: pageRoute(),\n    }),\n    // One call's full transcript, over the room.\n    CompanionCall: createNativeStackScreen({\n      screen: CompanionCallRouteScreen,\n      linking: \"companions/:companionId/calls/:callId\",\n      options: sheetRoute({ detent: 0.5, maxDetent: 0.92, header: \"none\" }),\n    }),\n    // Its profile from the face over the room, where its picture changes; the pictures of its\n    // room to pick one from; and the circle a new picture is placed in.\n    CompanionProfile: createNativeStackScreen({\n      screen: CompanionProfileRouteScreen,\n      linking: \"companions/:companionId/profile\",\n      options: sheetRoute({ detent: 0.5, maxDetent: 0.92, header: \"none\" }),\n    }),\n    CompanionPictures: createNativeStackScreen({\n      screen: CompanionPicturesRouteScreen,\n      linking: \"companions/:companionId/pictures\",\n      options: sheetRoute({ detent: 0.75, maxDetent: 0.92, header: \"none\" }),\n    }),\n    CompanionAvatarCrop: createNativeStackScreen({\n      screen: CompanionAvatarCropRouteScreen,\n      options: { ...modalRoute({ header: \"none\" }), gestureEnabled: false },\n    }),\n"],
  ],
  // Rubato's screens that keep a latest-value ref read during render, as T3's own listed ones do.
  'apps/mobile/src/reactCompilerCoverage.test.ts': [
    ["  \"src/features/diffs/nativeReviewDiffSurface.ts\": \"ref read during render\",\n",
      "  \"src/features/companions/CompanionRoomScreen.tsx\": \"ref read during render\",\n"],
    ["  \"src/features/threads/ThreadArrangementSheet.tsx\": \"ref read during render\",\n",
      "  \"src/features/rubato-push/RubatoPushHost.tsx\": \"ref read during render\",\n  \"src/features/rubato-voice/RubatoComposerField.tsx\": \"ref read during render\",\n"],
  ],
  // T3's identifier test, on Rubato's identifiers: no T3 link domains (shell edits to app.config.ts).
  'apps/mobile/app.config.test.ts': [
    ["import { DEFAULT_HOSTED_APP_URL } from \"@t3tools/shared/connectAuth\";\nimport { afterEach, expect, it, vi } from \"vite-plus/test\";\n\nimport appleAppSiteAssociation from \"../web/public/.well-known/apple-app-site-association.json\";\nimport assetLinks from \"../web/public/.well-known/assetlinks.json\";\n",
      "// Rubato: the app claims no T3 link domain, so T3's hosted-app files are not read here.\nimport { afterEach, expect, it, vi } from \"vite-plus/test\";\n", 'replace'],
    ["it.each([\n  [undefined, \"com.t3tools.t3code\"],\n  [\"development\", \"com.t3tools.t3code.dev\"],\n  [\"preview\", \"com.t3tools.t3code.preview\"],\n  [\"production\", \"com.t3tools.t3code\"],\n])(\"keeps the iOS and Android identifiers for APP_VARIANT=%j\", async (value, identifier) => {\n  const config = await loadConfig(value);\n  expect(config.ios?.bundleIdentifier).toBe(identifier);\n  expect(config.android?.package).toBe(identifier);\n  // Copied thread links open this app only while app.t3.codes lists it.\n  const host = new URL(DEFAULT_HOSTED_APP_URL).host;\n  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);\n  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(\n    `${config.ios?.appleTeamId}.${identifier}`,\n  );\n  expect(config.android?.intentFilters?.[0]?.data).toEqual([\n    { scheme: \"https\", host, pathPrefix: \"/threads/\" },\n  ]);\n  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);\n});",
      "it.each([\n  [undefined, \"com.keepitmello.rubato\"],\n  [\"development\", \"com.keepitmello.rubato.dev\"],\n  [\"preview\", \"com.keepitmello.rubato.preview\"],\n  [\"production\", \"com.keepitmello.rubato\"],\n])(\"builds Rubato's app for APP_VARIANT=%j\", async (value, identifier) => {\n  const config = await loadConfig(value);\n  expect(config.ios?.bundleIdentifier).toBe(identifier);\n  expect(config.ios?.appleTeamId).toBe(\"5WGZKZGPQS\");\n  // T3's hosted app and Clerk domains are T3's team's; Rubato's app claims none of them.\n  expect(config.ios?.associatedDomains ?? []).toEqual([]);\n});", 'replace'],
  ],
  // Korean: T3's catalog with Rubato's wording wherever Rubato's dictionary has the same English, the
  // same overlay the desktop loads (packages/shared rubatoWording.ts, i18n-edits.mjs), so the phone
  // and the desktop use one set of terms.
  'apps/mobile/src/i18n/I18nProvider.tsx': [
    ["import { setActiveLocale } from \"./messages\";\n",
      "import { setActiveLocale } from \"./messages\";\nimport { withRubatoWording } from \"@t3tools/shared/rubatoWording\";\n", 'replace'],
    ["  ko: () => require(\"./translations/ko.json\"),\n",
      "  ko: () =>\n    withRubatoWording(\n      require(\"./translations/ko.json\"),\n      require(\"./translations/en.json\"),\n      require(\"@t3tools/shared/rubatoI18n.ko.json\"),\n    ),\n", 'replace'],
  ],
  'apps/mobile/src/App.tsx': [
    ["import { ThreadArrangementHost } from \"./features/threads/ThreadArrangementSheet\";\n",
      "import { ThreadArrangementHost } from \"./features/threads/ThreadArrangementSheet\";\nimport { RubatoCallHost } from \"./features/rubato-shell/companionSurface\";\nimport { RubatoPushHost } from \"./features/rubato-push\";\n", 'replace'],
    // The call on screen and the ring of an open app, over every route; push tokens kept in line
    // with the relay and every paired Mac (features/rubato-push).
    ["                <ThreadArrangementHost />\n",
      "                <ThreadArrangementHost />\n                <RubatoCallHost />\n                <RubatoPushHost />\n", 'replace'],
    // The Live Activity's rows link with upstream's scheme (widgets/AgentActivity.tsx); a tap reaches
    // this app all the same, and opens that thread.
    ["    \"t3code://\",\n    \"t3code-dev://\",\n    \"t3code-preview://\",\n",
      "    \"rubato://\",\n    \"rubato-dev://\",\n    \"rubato-preview://\",\n    \"t3code://\",\n", 'replace'],
  ],
  // The Live Activity's mark: the curl of the Rubato icon, drawn as one stroke the card tints.
  'apps/mobile/assets/widget/T3Mark.svg': [
    ['<svg width="111" height="74" viewBox="7 29 111 74" fill="none" xmlns="http://www.w3.org/2000/svg">', '<svg width="66" height="78" viewBox="23 15 66 78" fill="none" xmlns="http://www.w3.org/2000/svg">', 'replace'],
    ["<path d=\"M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z\" fill=\"black\"/>",
      '<path d="M30 87C37 81 42 66 46 52C50 38 55 26 66 23C76 20.5 83 27 82 36C81 45 73 50 65 49C60 48.4 58.5 45 60.5 42.5" stroke="black" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round"/>', 'replace'],
  ],
  // An update published with mobile/update-ios.sh is looked for again when the app comes back after
  // two minutes, not fifteen: the check is one small request, and it only asks when there is one.
  'apps/mobile/src/features/updates/app-updates.ts': [
    ["const FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS = 15 * 60 * 1000;",
      "const FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS = 2 * 60 * 1000;", 'replace'],
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
    ["      accessibilityLabel={props.accessibilityLabel ?? gt(\"T3 Code, Threads\")}",
      "      accessibilityLabel={props.accessibilityLabel ?? \"Rubato\"}", 'replace'],
    ["      <T3Wordmark colorClassName=\"accent-icon\" height={Math.round(15 * scale)} />\n      {/* A logo beside a fixed-size wordmark: it may grow with Dynamic Type, not crowd the bar. */}\n      <Text\n        allowFontScaling={props.allowFontScaling}\n        maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}\n        className=\"font-t3-medium text-foreground-muted\"\n        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}\n      >\n        {WORDMARK_SUFFIX}\n      </Text>",
      "      <Text\n        allowFontScaling={props.allowFontScaling}\n        maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}\n        className=\"font-t3-bold text-foreground\"\n        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}\n      >\n        Rubato\n      </Text>", 'replace'],
    ["import { T3Wordmark } from \"./T3Wordmark\";\n",
      "// Rubato: the name, not T3's wordmark.\n", 'replace'],
    ["const WORDMARK_SUFFIX = \"Code\";\n",
      "// Rubato: no wordmark suffix; the title is the name.\n", 'replace'],
  ],
  'apps/mobile/src/components/brandAssets.ts': [
    ['export const T3_CODE_BRAND_MARK_SOURCE =\n  appVariant === "development"\n    ? require("../../../../assets/dev/blueprint-ios-1024.png")\n    : appVariant === "preview"\n      ? require("../../../../assets/nightly/nightly-ios-1024.png")\n      : require("../../../../assets/prod/black-ios-1024.png");',
      '// Rubato: one mark for every variant (build-ios.sh writes it).\nvoid appVariant;\nexport const T3_CODE_BRAND_MARK_SOURCE = require("../../assets/rubato/icon.png");', 'replace'],
  ],
  'apps/mobile/src/components/BrandMark.tsx': [
    ['text-foreground">T3 Code</Text>', 'text-foreground">Rubato</Text>', 'replace'],
    ['<T>Mobile control surface for your live coding environments</T>', '<T>Your companions and coding threads, from your Mac</T>', 'replace'],
  ],
  // Legal links open Rubato's own page (store/site, published at rubato-app.pages.dev).
  'apps/mobile/src/features/settings/lib/legal-document-url.ts': [
    ['const DEFAULT_MARKETING_SITE_URL = "https://t3.codes";', 'const DEFAULT_MARKETING_SITE_URL = "https://rubato-app.pages.dev";', 'replace'],
  ],
  'apps/mobile/src/features/settings/SettingsRouteScreen.tsx': [
    // Without T3's cloud this is the list that shows; Rubato's notifications live there too.
    ["      connections={[environmentsRow(gt(\"Environments\"), Object.keys(savedConnectionsById).length)]}",
      "      connections={[\n        environmentsRow(gt(\"Environments\"), Object.keys(savedConnectionsById).length),\n        {\n          id: \"SettingsNotifications\",\n          icon: \"bell.badge\",\n          label: gt(\"Notifications\"),\n          target: \"SettingsNotifications\",\n        },\n      ]}", 'replace'],
    ["        page(\"SettingsAppearance\", \"paintbrush\", gt(\"Appearance\")),\n",
      "        page(\"SettingsCompanions\", \"person.2\", gt(\"Companions\")),\n"],
  ],
  'apps/mobile/src/features/settings/components/settings-page-targets.ts': [
    ["  \"SettingsLanguage\",\n",
      "  \"SettingsCompanions\",\n"],
  ],
  'apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx': [
    // Restart the Mac's Rubato from here, as the Mac's own About does (rubato-shell/MacRestartSection.tsx).
    ['import { SettingsScreen } from "./components/SettingsScreen";\n',
      'import { SettingsScreen } from "./components/SettingsScreen";\nimport { MacRestartSection } from "../rubato-shell/MacRestartSection";\n', 'replace'],
    ['        <AppSettingsSection />\n', '        <AppSettingsSection />\n        <MacRestartSection />\n', 'replace'],
  ],

  // Model logos: a Rubato model shows its vendor, not T3's OpenAI fallback.
  'apps/mobile/src/components/ProviderIcon.tsx': [
    ['import { getProviderClient, openRouterIcon } from "@t3tools/client-runtime/provider-clients";\n',
      'import { getProviderClient, openRouterIcon } from "@t3tools/client-runtime/provider-clients";\nimport { resolveRubatoGlyph } from "./rubatoModelGlyph";\nimport { RubatoVendorMark } from "./RubatoVendorMark";\n', 'replace'],
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
  // The composer's model chip (thread and new task).
  'apps/mobile/src/components/ComposerModelControl.tsx': [
    ["            iconUrl={props.modelOption?.providerIconUrl}\n            provider={props.modelOption?.providerDriver}\n            displayName={badge.displayName}",
      "            iconUrl={props.modelOption?.providerIconUrl}\n            model={props.selection?.model}\n            provider={props.modelOption?.providerDriver}\n            displayName={badge.displayName}", 'replace'],
    ["            iconUrl={props.modelOption?.providerIconUrl}\n            provider={props.modelOption?.providerDriver}\n            size={size}",
      "            iconUrl={props.modelOption?.providerIconUrl}\n            model={props.selection?.model}\n            provider={props.modelOption?.providerDriver}\n            size={size}", 'replace'],
  ],
  'apps/mobile/src/features/threads/thread-list-v2-items.tsx': [
    ['provider={providerInstance.driverKind}\n', 'model={thread.modelSelection.model}\n              '],
  ],
};
