// The iPhone's navigation as it was before v0.1.11 (user, session 01a1fa8b item 530e2c09: "네비바도
// 바뀌었고"). v0.1.11 gives the iPhone a floating glass picker with Settings as a tab and compose beside it;
// the phone had UIKit's tab bar with named tabs, compose as a detached search-role tab, and Settings
// behind a gear in the header. Upstream keeps that tab bar for other layouts, so the iPhone is sent back
// to it and the three differences are put back:
//
//   useSystemWorkspaceTabBar.ts   the iPhone is not "compact": UIKit's tab bar shows, the picker does not
//   WorkspaceNativeTabs.ios.tsx   tab titles; no Settings tab (made only while Settings is open, with the
//                                 bar hidden); compose as a search-role tab that never becomes selected
//   WorkspaceToolbar.tsx          gear on the right opens Settings, a chevron on the left leaves it; no
//                                 compose button in the header on the iPhone
//
// Cost per upstream bump: 13 anchors in 3 files, all here.
export const mobileNavbarOverlays = [];

export const mobileNavbarEdits = {
  "apps/mobile/src/features/layout/workspace/useSystemWorkspaceTabBar.ts": [
    ["  // The compact glass picker reserves the trailing edge for a separate compose button.\n  return (\n    Platform.OS === \"ios\" &&\n    deviceType !== \"pad\" &&",
      "  // The compact glass picker reserves the trailing edge for a separate compose button.\n  // Rubato: the iPhone keeps UIKit's tab bar (WorkspaceNativeTabs), as before v0.1.11.\n  return (\n    Platform.OS === \"ios\" &&\n    deviceType !== \"pad\" &&\n    deviceType !== \"phone\" &&", 'replace'],
  ],
  "apps/mobile/src/features/layout/workspace/WorkspaceNativeTabs.ios.tsx": [
    ["import { Tabs, type TabSelectedEvent, type TabSelectionRejectedEvent } from \"react-native-screens\";",
      "import {\n  Tabs,\n  type TabSelectedEvent,\n  type TabSelectionPreventedEvent,\n  type TabSelectionRejectedEvent,\n} from \"react-native-screens\";", 'replace'],
    ["const ISSUE_ICON = require(\"../../../../assets/icons/issue.png\");\n",
      "const ISSUE_ICON = require(\"../../../../assets/icons/issue.png\");\n// Rubato: on the iPhone, compose is UIKit's own search-role tab, detached beside the tab bar as it\n// was before v0.1.11; it never becomes selected and starts a new chat instead.\nconst RUBATO_COMPOSE_TAB = \"compose\";\n", 'replace'],
    ["  const request = { selectedScreenKey, baseProvenance: provenance };",
      "  const request = { selectedScreenKey, baseProvenance: provenance };\n  // Rubato: the iPhone's tab bar names its tabs, has no Settings tab (Settings opens from the gear in\n  // the header, WorkspaceToolbar) and keeps compose beside it.\n  const phoneBar = systemTabBar && deviceType === \"phone\";\n  const compose = useWorkspaceCompose();", 'replace'],
    ["          tabBarHidden={props.hidden || !systemTabBar}",
      "          tabBarHidden={props.hidden || !systemTabBar || (phoneBar && workspace.settingsOpen)}", 'replace'],
    ["          onTabSelectionRejected={({",
      "          onTabSelectionPrevented={({\n            nativeEvent,\n          }: NativeSyntheticEvent<TabSelectionPreventedEvent>) => {\n            if (nativeEvent.preventedScreenKey === RUBATO_COMPOSE_TAB) compose?.onPress();\n          }}\n          onTabSelectionRejected={({", 'replace'],
    ["            const tab = settings ? (overflow ?? selectedTab) : primaryTabs[index];\n            if (!tab) return null;",
      "            const tab = settings ? (overflow ?? selectedTab) : primaryTabs[index];\n            if (!tab) return null;\n            if (settings && phoneBar && !workspace.settingsOpen) return null;", 'replace'],
    ["                title=\"\"",
      "                title={phoneBar && !settings ? m(WORKSPACE_TAB_LABELS[tab]) : \"\"}", 'replace'],
    ["            );\n          })}\n        </Tabs.Host>",
      "            );\n          })}\n          {phoneBar && compose !== null && !workspace.settingsOpen ? (\n            <Tabs.Screen\n              key={RUBATO_COMPOSE_TAB}\n              screenKey={RUBATO_COMPOSE_TAB}\n              title={compose.label}\n              preventNativeSelection\n              ios={{\n                role: \"search\",\n                // iOS 27 detaches a search tab only while it may activate search.\n                automaticallyActivatesSearch: true,\n                icon: { type: \"sfSymbol\", name: \"square.and.pencil\" },\n              }}\n            >\n              <View />\n            </Tabs.Screen>\n          ) : null}\n        </Tabs.Host>", 'replace'],
  ],
  "apps/mobile/src/features/layout/workspace/WorkspaceToolbar.tsx": [
    ["import { useWorkspaceCompose } from \"./useWorkspaceCompose\";",
      "import { useWorkspaceCompose } from \"./useWorkspaceCompose\";\nimport { useSelectWorkspaceTab } from \"./useSelectWorkspaceTab\";", 'replace'],
    ["  const compose = useWorkspaceCompose();",
      "  const compose = useWorkspaceCompose();\n  // Rubato: the iPhone opens Settings from a gear here and comes back with the chevron; compose sits\n  // beside its tab bar (WorkspaceNativeTabs), as before v0.1.11.\n  const phoneHeader = deviceType === \"phone\" && !floatingTabs;\n  const selectTab = useSelectWorkspaceTab();", 'replace'],
    ["      {workspace.settingsOpen ? (\n        <Toolbar placement=\"right\">",
      "      {phoneHeader && workspace.settingsOpen ? (\n        <Toolbar placement=\"left\">\n          <Toolbar.Button\n            accessibilityLabel={gt(\"Back\")}\n            icon=\"chevron.left\"\n            onPress={() => selectTab(workspace.state.selectedTab)}\n          />\n        </Toolbar>\n      ) : null}\n      {workspace.settingsOpen ? (\n        <Toolbar placement=\"right\">", 'replace'],
    ["          {compose === null ||\n          isDuoDevice(deviceType) ||",
      "          {phoneHeader ? (\n            <Toolbar.Button\n              accessibilityLabel={gt(\"Settings\")}\n              icon=\"gearshape\"\n              onPress={() => selectTab(\"settings\")}\n            />\n          ) : null}\n          {compose === null ||\n          phoneHeader ||\n          isDuoDevice(deviceType) ||", 'replace'],
  ],
};
