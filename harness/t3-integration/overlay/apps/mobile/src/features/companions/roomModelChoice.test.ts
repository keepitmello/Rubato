import { describe, expect, it, vi } from "vite-plus/test";
import { COMPANION_GEMINI_DEFAULT_MODEL } from "@t3tools/shared/rubatoCompanionModelChoice";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { roomModelMenu, roomModelRequest, type RoomModelMenuInput } from "./roomModelChoice";

const HYDROGEN = `${COMPANION_GEMINI_DEFAULT_MODEL}-medium`;
const labels = { menu: "Model", rubato: "Rubato", gemini: (account: string) => `Gemini · ${account}`, defaultModel: "Default" };

const provider = (fields: Partial<RoomModelMenuInput["providers"][number]> & Pick<RoomModelMenuInput["providers"][number], "instanceId" | "driver" | "models">) => ({
  enabled: true,
  installed: true,
  status: "ready" as const,
  availability: "available" as const,
  displayName: undefined,
  ...fields,
});

// The Mac as the phone's server config shows it: the room's engine, a second engine, a local agy account,
// an Antigravity account that is not a local agy one, and Codex.
const rubato = provider({
  instanceId: "rubato-pi" as never,
  driver: "rubato-pi" as never,
  displayName: "Rubato",
  models: [
    { slug: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", subProvider: "anthropic" },
    { slug: "xai/grok-4.7", name: "Grok 4.7", subProvider: "xai" },
    { slug: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", subProvider: "anthropic" },
    { slug: "rubato-companion-acp-work/gemini-4-hydrogen", name: "internal route", subProvider: "rubato-companion-acp-work" },
  ],
});
const otherEngine = provider({
  instanceId: "rubato-pi-sub" as never,
  driver: "rubato-pi" as never,
  models: [{ slug: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5 (sub)", subProvider: "anthropic" }],
});
const work = provider({
  instanceId: "antigravity-work" as never,
  driver: "antigravity" as never,
  displayName: "Work",
  models: [
    { slug: "gemini-4-neon", name: "Gemini 4 Neon" },
    { slug: HYDROGEN, name: "Gemini 4 Hydrogen" },
    { slug: "claude-opus-5-5", name: "Claude via AGY" },
  ],
});
const cloudAgy = provider({
  instanceId: "antigravity" as never,
  driver: "antigravity" as never,
  models: [{ slug: HYDROGEN, name: "Gemini 4 Hydrogen" }],
});
const codex = provider({ instanceId: "codex" as never, driver: "codex" as never, models: [{ slug: "gpt-6.1", name: "GPT 6.1" }] });
const instances = {
  "antigravity-work": { driver: "antigravity", environment: [{ name: "RUBATO_LOCAL_AGY_AGENT", value: "work" }, { name: "RUBATO_LOCAL_AGY_ISOLATED", value: "1" }] },
  antigravity: { driver: "antigravity" },
} as unknown as RoomModelMenuInput["instances"];

function menu(overrides: Partial<RoomModelMenuInput> = {}) {
  return roomModelMenu({
    providers: [codex, otherEngine, rubato, cloudAgy, work],
    instances,
    owner: "rubato-pi",
    applied: null,
    busy: false,
    labels,
    onPick: () => {},
    ...overrides,
  });
}

type Shape = string | { readonly title: string | undefined; readonly items: ReadonlyArray<Shape> };
const shape = (items: ReadonlyArray<AppBarMenuItem>): ReadonlyArray<Shape> =>
  items.map((item) =>
    "items" in item
      ? { title: item.title, items: shape(item.items) }
      : `${item.title}${item.subtitle ? ` (${item.subtitle})` : ""}${item.selected ? " ✓" : ""}${item.disabled ? " off" : ""}`,
  );
const actions = (items: ReadonlyArray<AppBarMenuItem>): Array<Extract<AppBarMenuItem, { onPress: () => void }>> =>
  items.flatMap((item) => ("items" in item ? actions(item.items) : [item]));

describe("roomModelMenu", () => {
  it("offers the room's own engine by sub-provider, then each local agy account's Gemini models", () => {
    const result = menu();
    expect(result?.title).toBe("Model");
    expect(shape(result!.items)).toEqual([
      {
        title: "Rubato",
        items: [
          { title: "anthropic", items: ["Claude Opus 5.5", "Claude Sonnet 5"] },
          { title: "xai", items: ["Grok 4.7"] },
        ],
      },
      { title: "Gemini · Work", items: ["Gemini 4 Neon", "Gemini 4 Hydrogen (Default)"] },
    ]);
  });

  it("sends exactly the routing fields of the row picked, with no options", () => {
    const onPick = vi.fn();
    const result = menu({ onPick });
    const rows = actions(result!.items);
    rows.find((row) => row.title === "Claude Sonnet 5")!.onPress();
    rows.find((row) => row.title === "Gemini 4 Hydrogen")!.onPress();
    expect(onPick.mock.calls).toEqual([
      [{ instanceId: "rubato-pi", model: "anthropic/claude-sonnet-5" }],
      [{ instanceId: "antigravity-work", model: HYDROGEN }],
    ]);
    // Never another engine's instance, the engine's internal Gemini route, an AGY non-Gemini model or Codex.
    const offered = rows.map((row) => row.id);
    expect(offered.some((id) => id.startsWith("rubato-pi-sub\u0000"))).toBe(false);
    expect(offered.some((id) => id.includes("rubato-companion-acp"))).toBe(false);
    expect(offered.some((id) => id.endsWith("\u0000claude-opus-5-5"))).toBe(false);
    expect(offered.some((id) => id.startsWith("codex\u0000") || id.startsWith("antigravity\u0000"))).toBe(false);
  });

  it("ticks only the pick this room applied, and holds every row while a pick is on its way", () => {
    const ticked = menu({ applied: { instanceId: "antigravity-work", model: HYDROGEN } });
    expect(actions(ticked!.items).filter((row) => row.selected).map((row) => row.title)).toEqual(["Gemini 4 Hydrogen"]);
    // The same model slug on the engine is another pick.
    expect(actions(menu({ applied: { instanceId: "rubato-pi", model: HYDROGEN } })!.items).some((row) => row.selected)).toBe(false);
    const busy = menu({ busy: true });
    expect(actions(busy!.items).every((row) => row.disabled)).toBe(true);
    expect(actions(menu()!.items).some((row) => row.disabled)).toBe(false);
  });

  it("lists one sub-provider's models straight under Rubato", () => {
    const single = provider({ ...rubato, models: [rubato.models[0]!, rubato.models[2]!] });
    expect(shape(menu({ providers: [single] })!.items)).toEqual([
      { title: "Rubato", items: ["Claude Opus 5.5", "Claude Sonnet 5"] },
    ]);
  });

  it("reads a model's sub-provider from its slug when the snapshot names none", () => {
    const bare = provider({ ...rubato, models: [{ slug: "xai/grok-4.7", name: "Grok 4.7" }, { slug: "no-slash", name: "Not a Pi model" }] });
    expect(shape(menu({ providers: [bare] })!.items)).toEqual([{ title: "Rubato", items: ["Grok 4.7"] }]);
  });

  it("offers no Rubato model when the room's engine is down or unknown, and nothing at all with no account either", () => {
    const down = provider({ ...rubato, status: "error" });
    expect(shape(menu({ providers: [down, work] })!.items).map((group) => (group as { title: string }).title)).toEqual(["Gemini · Work"]);
    expect(shape(menu({ owner: null })!.items).map((group) => (group as { title: string }).title)).toEqual(["Gemini · Work"]);
    // The owner must be a Rubato engine: an Antigravity thread owner offers no Rubato group.
    expect(shape(menu({ owner: "antigravity-work" })!.items).map((group) => (group as { title: string }).title)).toEqual(["Gemini · Work"]);
    expect(menu({ providers: [down, codex, cloudAgy] })).toBeNull();
  });
});

describe("roomModelRequest", () => {
  it("is the thread and the two routing fields the Mac accepts", () => {
    const selection = { instanceId: "antigravity-work", model: HYDROGEN, options: [{ id: "effort", value: "high" }] };
    expect(roomModelRequest("thread-1", selection)).toEqual({
      threadId: "thread-1",
      modelSelection: { instanceId: "antigravity-work", model: HYDROGEN },
    });
  });
});
