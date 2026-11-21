// A companion as this phone knows it, and the copy of the list the phone keeps between launches.
// The list is the app's first tab and a room needs its thread id before it can show anything, so
// waiting for the Mac on every launch left the room on "loading" until the connection, the list
// and each companion's thread lookup had all answered. The kept copy opens both at once; the Mac's
// answer replaces it when it comes (companionsStore.ts). No native module here, so tests read it.
import type { EnvironmentId } from "@t3tools/contracts";

import type { CallableCompanion } from "./callStore";

/** The companion conversation's effort while a call is open (harness/companion/companion.mjs CALL_EFFORTS). */
export type CallEffort = "conversation" | "low" | "medium" | "high";
export const CALL_EFFORTS: readonly CallEffort[] = ["conversation", "low", "medium", "high"];

export interface CompanionEntry {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  /** The name this phone shows (companionNames.ts: a rename, or 루/세뇨). */
  readonly title: string;
  /** The name the Mac knows it by. */
  readonly macTitle: string;
  readonly sessionId: string | null;
  /** The T3 thread that is its room; null until the Mac's app picked its conversation up. */
  readonly threadId: string | null;
  /** Its picture as a data URL, or null. */
  readonly art: string | null;
  readonly callable: CallableCompanion | null;
  /** Whether it takes voice calls, and how much it thinks on one. */
  readonly calls: boolean;
  readonly callEffort: CallEffort;
}

export const COMPANIONS_CACHE_KEY = "rubato.companions.v1";

/**
 * The list as kept. Whether a call can go through now is left out: it changes with the Mac's
 * state and only a fresh answer may say yes.
 */
export function encodeCompanions(companions: readonly CompanionEntry[]): string {
  return JSON.stringify(companions.map(({ callable: _callable, ...entry }) => entry));
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const textOrNull = (value: unknown): string | null => (text(value) ? value : null);

/** The kept list, without any entry that does not read as one; empty for anything else. */
export function decodeCompanions(stored: string | null): CompanionEntry[] {
  if (stored === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: Record<string, unknown> | null): CompanionEntry[] => {
    if (item === null || typeof item !== "object" || !text(item.environmentId) || !text(item.id)) return [];
    const macTitle = textOrNull(item.macTitle) ?? item.id;
    return [{
      environmentId: item.environmentId as EnvironmentId,
      id: item.id,
      title: textOrNull(item.title) ?? macTitle,
      macTitle,
      sessionId: textOrNull(item.sessionId),
      threadId: textOrNull(item.threadId),
      art: textOrNull(item.art),
      callable: null,
      calls: item.calls === true,
      callEffort: CALL_EFFORTS.includes(item.callEffort as CallEffort) ? (item.callEffort as CallEffort) : "medium",
    }];
  });
}

/**
 * The room's thread when the Mac did not say which one it is now (it was slow or unreachable): the
 * one this phone last knew for the same conversation, so the room, its preview and the Threads
 * tab's filter keep working. A new conversation (another session) has no known thread yet.
 */
export function knownThreadId(
  companions: readonly CompanionEntry[],
  environmentId: string,
  companionId: string,
  sessionId: string | null,
): string | null {
  const known = companions.find((item) => item.environmentId === environmentId && item.id === companionId);
  return known && known.sessionId === sessionId ? known.threadId : null;
}
