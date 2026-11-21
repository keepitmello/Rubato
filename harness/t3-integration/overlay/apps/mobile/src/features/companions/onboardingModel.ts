// A new companion's first conversation (intent companion-manage): it wakes without a name and
// learns, one topic at a time, its name, what it calls the person, what the person does and what
// they are to each other; how it looks, how it talks and how close they are may wait for later.
// The Mac's companion list carries where that stands (`onboarding` on each row, null once it
// settled); the room shows it as chips under its header. No native module here, so tests read it.

/** The topics in the order the chips show them; the first four are the ones it needs. */
export const ONBOARDING_KEYS = ["name", "callsUser", "work", "relationship", "look", "speech", "closeness"] as const;
export type OnboardingKey = (typeof ONBOARDING_KEYS)[number];
export const REQUIRED_ONBOARDING_KEYS: ReadonlySet<OnboardingKey> = new Set(["name", "callsUser", "work", "relationship"]);

/** set: settled in conversation; open: not talked about yet; deferred: left for later on purpose. */
export type OnboardingState = "set" | "open" | "deferred";

export interface OnboardingItem {
  readonly key: OnboardingKey;
  readonly state: OnboardingState;
  readonly value: string | null;
}

export interface Onboarding {
  readonly items: readonly OnboardingItem[];
}

const STATES: readonly OnboardingState[] = ["set", "open", "deferred"];

/**
 * The Mac's `onboarding` as the phone keeps it: every known topic once, in chip order, a topic the
 * Mac did not mention as open. Null for null or anything that does not read as one; a topic this
 * phone does not know yet is left out rather than shown with a raw key.
 */
export function decodeOnboarding(value: unknown): Onboarding | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as { items?: unknown }).items;
  if (!Array.isArray(raw)) return null;
  const byKey = new Map<OnboardingKey, OnboardingItem>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const { key, state, value: text } = entry as { key?: unknown; state?: unknown; value?: unknown };
    if (!ONBOARDING_KEYS.includes(key as OnboardingKey) || byKey.has(key as OnboardingKey)) continue;
    byKey.set(key as OnboardingKey, {
      key: key as OnboardingKey,
      state: STATES.includes(state as OnboardingState) ? (state as OnboardingState) : "open",
      value: typeof text === "string" && text.trim() ? text.trim() : null,
    });
  }
  return { items: ONBOARDING_KEYS.map((key) => byKey.get(key) ?? { key, state: "open", value: null }) };
}

/** Whether the four topics it needs are settled. */
export function onboardingReady(onboarding: Onboarding): boolean {
  return onboarding.items.every((item) => !REQUIRED_ONBOARDING_KEYS.has(item.key) || item.state === "set");
}
