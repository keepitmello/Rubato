import { installContextNotes } from "../../src/extensions/context-notes.mjs";
import { installServerCompaction } from "../../src/extensions/server-compaction.mjs";

export default async function install(pi) {
  installServerCompaction(pi);
  await installContextNotes(pi);
}
