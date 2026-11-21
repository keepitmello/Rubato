import type { EffortLevel, EffortSettings } from "../../state/rubatoAuth";

/** Pi's levels, weakest first; a level a model does not offer meets the nearest one in this order. */
const ORDER: readonly EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What the page offers for every model: the levels a picker shows (src/model-catalog-order.mjs). */
export const DEFAULT_CHOICES: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABEL: Readonly<Record<EffortLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (ORDER as readonly string[]).includes(value);
}

/**
 * `wanted` at the nearest level the model offers: itself, else the next one up, else the next one
 * down, the way Pi clamps it (pickerStartLevel in src/model-catalog-order.mjs).
 */
export function nearestLevel(wanted: EffortLevel, offered: readonly string[]): string | null {
  if (offered.includes(wanted)) return wanted;
  const index = ORDER.indexOf(wanted);
  const up = ORDER.slice(index + 1).find((level) => offered.includes(level));
  const down = ORDER.slice(0, index).reverse().find((level) => offered.includes(level));
  return up ?? down ?? null;
}

interface ModelCapabilities {
  readonly optionDescriptors?: ReadonlyArray<{
    readonly id: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  }>;
}

/** The effort levels a model's picker offers, from the Rubato catalogue; empty for a model without them. */
export function offeredLevels(capabilities: unknown): ReadonlyArray<{ id: string; label: string }> {
  const descriptors = (capabilities as ModelCapabilities | null | undefined)?.optionDescriptors ?? [];
  return descriptors.find((descriptor) => descriptor.id === "reasoningEffort")?.options ?? [];
}

export interface ModelEffortView {
  /** The model's own level, or null when it follows the level for every model. */
  readonly own: EffortLevel | null;
  /** The level a new conversation starts at on this model while it follows that one; null when unknown. */
  readonly followed: string | null;
}

export function modelEffortView(slug: string, offered: readonly string[], settings: EffortSettings | null): ModelEffortView {
  const own = settings?.models[slug] ?? null;
  const followed = settings?.defaultLevel ? nearestLevel(settings.defaultLevel, offered) : null;
  return { own, followed };
}
