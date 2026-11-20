import { Directory, File, Paths } from "expo-file-system";

import type { SoundFolder } from "./sounds";

/** The app's Library/Sounds, beside Documents: where iOS looks for a notification's sound. */
export function librarySounds(): SoundFolder {
  const folder = new Directory(Paths.document.parentDirectory, "Library", "Sounds");
  return {
    size: (name) => {
      const file = new File(folder, name);
      return file.exists ? file.size : null;
    },
    write: async (name, bytes) => {
      if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
      await new File(folder, name).write(bytes);
    },
  };
}
