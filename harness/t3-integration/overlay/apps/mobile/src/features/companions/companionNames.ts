// What this phone calls each companion: Korean by default (루, 세뇨), or the person's own name for
// it from Settings › Companions (user 3efe742c). Only the phone changes; the Mac and the desktop
// keep their names. The renames live in the native module's app-group store
// (modules/rubato-call ios/CompanionIdentity.swift), where the system call screen and the
// notification service extension read them too.
import { useSyncExternalStore } from "react";

import { RubatoCall } from "../../../modules/rubato-call";

/** Korean names until the person picks their own; keep in step with CompanionIdentity.defaultNames. */
export const DEFAULT_COMPANION_NAMES: Readonly<Record<string, string>> = { roo: "루", segno: "세뇨" };

let renames: Readonly<Record<string, string>> = readRenames();
const listeners = new Set<() => void>();

function readRenames(): Readonly<Record<string, string>> {
  try {
    return RubatoCall?.getCompanionRenames() ?? {};
  } catch {
    return {};
  }
}

/** The person's rename, else the Korean default, else the Mac's name. */
export function companionDisplayName(companionId: string, macTitle?: string | null): string {
  return renames[companionId] ?? DEFAULT_COMPANION_NAMES[companionId] ?? macTitle ?? companionId;
}

/** The name the person gave, or null while the default stands. */
export function companionRename(companionId: string): string | null {
  return renames[companionId] ?? null;
}

/** A blank name goes back to the default. */
export function renameCompanion(companionId: string, name: string) {
  const trimmed = name.trim();
  const next = { ...renames };
  if (trimmed) next[companionId] = trimmed;
  else delete next[companionId];
  renames = next;
  RubatoCall?.setCompanionRename(companionId, trimmed || null);
  for (const listener of listeners) listener();
}

export function subscribeCompanionNames(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when a name changes. */
export function useCompanionNames() {
  return useSyncExternalStore(subscribeCompanionNames, () => renames);
}

/** A data URL's bytes as base64, for the native store; null for anything else. */
export function dataUrlBase64(url: string | null): string | null {
  const match = url?.match(/^data:[^;,]+;base64,(.+)$/);
  return match?.[1] ?? null;
}
