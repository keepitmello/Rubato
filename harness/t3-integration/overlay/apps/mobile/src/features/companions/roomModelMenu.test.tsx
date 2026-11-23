// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { COMPANION_GEMINI_DEFAULT_MODEL } from "@t3tools/shared/rubatoCompanionModelChoice";

const { postRubato, showActions } = vi.hoisted(() => ({ postRubato: vi.fn(), showActions: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { navigate: vi.fn() },
  useNavigation: () => ({ dispatch: vi.fn() }),
  useRoute: () => ({ params: { companionId: "roo", environmentId: "mac" } }),
}));
vi.mock("expo-haptics", () => ({ notificationAsync: vi.fn(), NotificationFeedbackType: { Success: "success" } }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("react-native", () => ({
  ActionSheetIOS: { showActionSheetWithOptions: showActions },
  Alert: { alert: vi.fn() },
  Platform: { OS: "ios" },
  Pressable: ({ children, onPress, disabled, accessibilityLabel }: {
    children: React.ReactNode; onPress: () => void; disabled?: boolean; accessibilityLabel?: string;
  }) => createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel }, children),
  ScrollView: ({ children }: React.PropsWithChildren) => createElement("div", null, children),
  View: ({ children }: React.PropsWithChildren) => createElement("div", null, children),
  Modal: () => null,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: React.PropsWithChildren) => createElement("span", null, children),
}));
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: () => ({ modelSelection: { instanceId: "rubato-pi" } }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({
    serverConfig: {
      providers: [
        {
          instanceId: "antigravity-work", driver: "antigravity", enabled: true, installed: true,
          status: "ready", availability: "available", displayName: "Work",
          models: [{ slug: `${COMPANION_GEMINI_DEFAULT_MODEL}-medium`, name: "Gemini 4 Hydrogen" }],
        },
      ],
      settings: { providerInstances: {
        "antigravity-work": { environment: [{ name: "RUBATO_LOCAL_AGY_AGENT", value: "work" }] },
      } },
    },
  }),
}));
vi.mock("./avatarPicture", () => ({ chooseFromAlbum: vi.fn(), takePhoto: vi.fn() }));
vi.mock("./CompanionAvatar", () => ({ CompanionAvatar: () => null }));
vi.mock("./companionsStore", () => ({
  useCompanion: () => ({ companion: { title: "Roo", macTitle: "Roo", threadId: "room" } }),
}));
vi.mock("./roomRequests", () => ({ requestRoomComposer: vi.fn() }));
vi.mock("./rubatoHttp", () => ({ postRubato }));

import { CompanionProfileScreen } from "./CompanionProfileScreen";
import { copy } from "./copy";

it("changes the existing room's model from its profile sheet without replacing picture controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  postRubato.mockResolvedValue({});
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (label: string) => {
    const element = Array.from(container.querySelectorAll("button")).find(item => item.textContent?.startsWith(label));
    if (!element) throw new Error(`No button named ${label}`);
    return element;
  };
  try {
    act(() => root.render(<CompanionProfileScreen route={{ params: { companionId: "roo", environmentId: "mac" } }} />));
    act(() => button(copy.changePicture).click());
    expect(showActions.mock.calls[0]?.[0].options).toContain(copy.takePhoto);
    act(() => button(copy.changeModel).click());
    act(() => button("Gemini · Work").click());
    act(() => button(copy.back).click());
    act(() => button("Gemini · Work").click());
    await act(async () => button("Gemini 4 Hydrogen").click());
    expect(postRubato).toHaveBeenCalledOnce();
    expect(postRubato).toHaveBeenCalledWith("mac", "/rubato/companion-room", "model", {
      threadId: "room", modelSelection: { instanceId: "antigravity-work", model: `${COMPANION_GEMINI_DEFAULT_MODEL}-medium` },
    }, { timeoutMs: 30_000 });
    expect(button(copy.changePicture)).toBeTruthy();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
