// @vitest-environment jsdom
// The room's model menu through T3's own header: createNativeHeaderMenu and the right-side Toolbar
// the room already has turn it into the native bar items, beside the call button.
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

type HeaderOptions = { unstable_headerRightItems?: () => NativeStackHeaderItem[] };
const harness = vi.hoisted(() => ({ items: [] as NativeStackHeaderItem[] }));

// As in NativeHeaderToolbar.test.tsx: the header materializes its items when options are set.
vi.mock("@react-navigation/native", async () => {
  const { createContext, use } = await vi.importActual<typeof import("react")>("react");
  const navigation = {
    setOptions(options: HeaderOptions) {
      if (options.unstable_headerRightItems) harness.items = options.unstable_headerRightItems();
    },
  };
  const navigationContext = createContext<typeof navigation | undefined>(navigation);
  return {
    NavigationRouteContext: createContext(undefined),
    NavigationContext: navigationContext,
    useNavigation: () => use(navigationContext),
    useRoute: () => ({ key: "room", name: "CompanionRoom", params: { companionId: "roo" } }),
  };
});
vi.mock("expo-glass-effect", () => ({ GlassContainer: () => null }));

import { createNativeHeaderMenu } from "../../components/ui/nativeHeaderMenu.ios";
import { Toolbar } from "../../components/ui/Toolbar";
import { roomModelMenu } from "./roomModelChoice";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.items = [];
  vi.unstubAllGlobals();
});

const providers = [
  {
    instanceId: "rubato-pi", driver: "rubato-pi", enabled: true, installed: true, status: "ready", availability: "available", displayName: "Rubato",
    models: [
      { slug: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", subProvider: "anthropic" },
      { slug: "xai/grok-4.7", name: "Grok 4.7", subProvider: "xai" },
    ],
  },
  {
    instanceId: "antigravity-work", driver: "antigravity", enabled: true, installed: true, status: "ready", availability: "available", displayName: "Work",
    models: [{ slug: "gemini-4-neon", name: "Gemini 4 Neon" }, { slug: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen" }],
  },
] as never;
const instances = { "antigravity-work": { driver: "antigravity", environment: [{ name: "RUBATO_LOCAL_AGY_AGENT", value: "work" }] } } as never;

it("draws the model menu left of the call button, nested by engine and account, and a row picks its model", () => {
  const onPick = vi.fn();
  const call = vi.fn();
  const menu = roomModelMenu({
    providers, instances, owner: "rubato-pi", applied: { instanceId: "rubato-pi", model: "xai/grok-4.7" }, busy: false,
    labels: { menu: "Model", rubato: "Rubato", gemini: (account) => `Gemini · ${account}`, defaultModel: "Default" },
    onPick,
  });
  expect(menu).not.toBeNull();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  // The room's toolbar (CompanionRoomScreen.tsx): the menu, then the call button.
  act(() =>
    root!.render(
      <Toolbar placement="right">
        {menu ? createNativeHeaderMenu(menu) : null}
        <Toolbar.Button accessibilityLabel="Call" icon="phone.fill" onPress={call} />
      </Toolbar>,
    ),
  );
  expect(harness.items.map((item) => item.type)).toEqual(["menu", "button"]);
  const [header, button] = harness.items;
  if (header?.type !== "menu" || button?.type !== "button") throw new Error("Expected the menu, then the call button");
  expect(header.accessibilityLabel).toBe("Model");
  expect(header.icon).toEqual({ type: "sfSymbol", name: "brain" });
  type Item = (typeof header.menu.items)[number];
  const outline = (items: ReadonlyArray<Item>): unknown[] =>
    items.map((item) =>
      item.type === "submenu" ? { [item.label]: outline(item.items) } : `${item.label}${item.description ? ` (${item.description})` : ""}${item.state === "on" ? " ✓" : ""}`,
    );
  expect(outline(header.menu.items)).toEqual([
    { Rubato: [{ anthropic: ["Claude Opus 5.5"] }, { xai: ["Grok 4.7 ✓"] }] },
    { "Gemini · Work": ["Gemini 4 Neon", "Gemini 4 Hydrogen (Default)"] },
  ]);
  // The native menu calls the row's handler: Gemini Hydrogen on the Work account.
  const gemini = header.menu.items[1];
  if (gemini?.type !== "submenu") throw new Error("Expected the Gemini account submenu");
  const hydrogen = gemini.items[1];
  if (hydrogen?.type !== "action") throw new Error("Expected the Hydrogen row");
  act(() => hydrogen.onPress());
  expect(onPick).toHaveBeenCalledWith({ instanceId: "antigravity-work", model: "gemini-4-hydrogen-medium" });
  act(() => button.onPress?.());
  expect(call).toHaveBeenCalledTimes(1);
});
