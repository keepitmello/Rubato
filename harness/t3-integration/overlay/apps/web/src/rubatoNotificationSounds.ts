import type { EnvironmentId } from "@t3tools/contracts";
import {
  DEFAULT_NOTIFICATION_COMPLETION_SOUND,
  DEFAULT_NOTIFICATION_INPUT_SOUND,
} from "@t3tools/contracts/settings";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";
import { getClientSettings } from "./hooks/useSettings";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import { postRubato, rubatoHttpAccess } from "./state/rubatoHttp";
import { readPreparedConnection } from "./state/session";

// Which sound a thread notification plays (Settings > General > Behavior).
// A sound id is "builtin:completion" or "builtin:input", T3's two sounds, or
// "mac:<folder>/<file>", one of this Mac's alert sounds that the server lists
// and sends (harness/t3-integration/src/sounds/service.mjs in the Rubato checkout).

export type NotificationSoundKind = "completion" | "input";

export const SOUNDS_ROUTE = "/rubato/sounds";

export interface MacSound {
  readonly id: string;
  readonly name: string;
  readonly folder: "system" | "local" | "user";
}

export const BUILT_IN_NOTIFICATION_SOUNDS = [
  { id: DEFAULT_NOTIFICATION_COMPLETION_SOUND, name: "Completion chime" },
  { id: DEFAULT_NOTIFICATION_INPUT_SOUND, name: "Input chime" },
] as const;

const BUILT_IN_URLS: Readonly<Record<string, string>> = {
  [DEFAULT_NOTIFICATION_COMPLETION_SOUND]: completionUrl,
  [DEFAULT_NOTIFICATION_INPUT_SOUND]: inputUrl,
};

export const NOTIFICATION_SOUND_SETTING = {
  completion: "notificationCompletionSound",
  input: "notificationInputSound",
} as const;

export function defaultNotificationSound(kind: NotificationSoundKind): string {
  return kind === "completion" ? DEFAULT_NOTIFICATION_COMPLETION_SOUND : DEFAULT_NOTIFICATION_INPUT_SOUND;
}

export function selectedNotificationSound(kind: NotificationSoundKind): string {
  return getClientSettings()[NOTIFICATION_SOUND_SETTING[kind]];
}

/** The name a sound id shows in the picker; a Mac sound not listed (yet) shows its file name. */
export function notificationSoundLabel(id: string, macSounds: ReadonlyArray<MacSound>): string {
  const builtIn = BUILT_IN_NOTIFICATION_SOUNDS.find((sound) => sound.id === id);
  if (builtIn) return builtIn.name;
  const listed = macSounds.find((sound) => sound.id === id);
  if (listed) return listed.name;
  return id.replace(/^mac:[^/]+\//, "").replace(/\.[^.]+$/, "");
}

/** This Mac's alert sounds, as the primary environment's server lists them. */
export async function listMacSounds(environmentId: EnvironmentId): Promise<MacSound[]> {
  const payload = await postRubato<{ sounds?: MacSound[] }>(environmentId, SOUNDS_ROUTE, "list", {}, "sounds");
  return payload.sounds ?? [];
}

/** The encoded audio for a sound id; rejects when it cannot be fetched. */
export async function loadNotificationSound(id: string): Promise<ArrayBuffer> {
  const builtIn = BUILT_IN_URLS[id];
  if (builtIn) {
    const response = await fetch(builtIn);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  }
  if (!id.startsWith("mac:")) throw new Error(`Unknown notification sound: ${id}`);
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
  if (!prepared) throw new Error("This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access) throw new Error("Mac sounds are not available on this connection.");
  const response = await fetch(`${access.baseUrl}${SOUNDS_ROUTE}/file`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}
