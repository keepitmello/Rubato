// The chimes thread alerts ring with on this iPhone: the ones the desktop plays (Settings > General >
// Behavior on the Mac), so a finish sounds the same on both. iOS plays a notification's `sound` from
// the app's Library/Sounds; the Mac names the file in each alert (src/push/service.mjs, phoneSoundFile).
//
//   T3's two chimes      rubato-completion.caf, rubato-input.caf   written from builtinSounds.ts
//   a Mac alert sound    rubato-mac-<hash>.caf                     fetched from that Mac, as CAF
//
// A file the phone does not have yet plays as the default sound.
import { COMPLETION_CAF_BASE64, INPUT_CAF_BASE64 } from "./builtinSounds";
import type { MacConnection } from "./sync";

export const BUILTIN_SOUNDS: Readonly<Record<string, string>> = {
  "rubato-completion.caf": COMPLETION_CAF_BASE64,
  "rubato-input.caf": INPUT_CAF_BASE64,
};

/** Library/Sounds, by file name. */
export interface SoundFolder {
  readonly size: (name: string) => number | null;
  readonly write: (name: string, bytes: Uint8Array) => Promise<void>;
}

export interface SoundSyncDeps {
  readonly folder: SoundFolder;
  readonly fetch: typeof fetch;
  readonly log?: (message: string, detail?: unknown) => void;
}

interface MacSound {
  readonly kind: string;
  readonly id: string;
  readonly file: string | null;
}

const SOUND_FILE = /^rubato-[A-Za-z0-9_-]{1,40}\.caf$/;

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function macPost(deps: SoundSyncDeps, connection: MacConnection, route: string, body: unknown): Promise<Response | null> {
  const response = await deps.fetch(`${connection.httpBaseUrl.replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${connection.bearerToken}` },
    body: JSON.stringify(body),
  });
  return response.ok ? response : null;
}

/** Puts the chimes each paired Mac rings with into Library/Sounds. Never throws. */
export async function syncNotificationSounds(deps: SoundSyncDeps, connections: ReadonlyArray<MacConnection>): Promise<void> {
  const log = deps.log ?? (() => {});
  for (const [name, base64] of Object.entries(BUILTIN_SOUNDS)) {
    const bytes = decodeBase64(base64);
    if (deps.folder.size(name) === bytes.length) continue;
    await deps.folder.write(name, bytes).catch((error: unknown) => log("rubato push: chime not written", { name, error }));
  }
  for (const connection of connections) {
    try {
      // A Mac from before Rubato push knew chimes answers 404: its alerts ring the default sound.
      const listed = await macPost(deps, connection, "/rubato/push/sounds", {});
      const sounds = ((await listed?.json().catch(() => null)) as { sounds?: MacSound[] } | null)?.sounds ?? [];
      for (const sound of sounds) {
        if (!sound.file || !SOUND_FILE.test(sound.file) || !sound.id.startsWith("mac:") || deps.folder.size(sound.file)) continue;
        const file = await macPost(deps, connection, "/rubato/sounds/file", { id: sound.id, for: "phone" });
        if (!file) continue;
        await deps.folder.write(sound.file, new Uint8Array(await file.arrayBuffer()));
      }
    } catch (error) {
      log("rubato push: the Mac's chimes not fetched", { environmentId: connection.environmentId, error });
    }
  }
}
