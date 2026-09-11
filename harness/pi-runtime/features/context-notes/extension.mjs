import { Type } from "typebox";

import { getAgentDir } from "../../config.js";
import { installContextNotes } from "./src/extensions/context-notes.mjs";

/**
 * Stock Pi extension adapter for Rubato's context-note policy and store.
 *
 * Pi's ExtensionContext intentionally does not expose agentDir. Keep that
 * filesystem choice at this adapter boundary and pass it to the Rubato-owned
 * controller explicitly instead of adding a process-global or core SDK hook.
 */
export function createContextNotesExtension(options = {}) {
  const agentDir = options.agentDir ?? getAgentDir();
  return async (pi) => installContextNotes(pi, {
    ...options,
    agentDir,
    Type: options.Type ?? Type,
    // Stock 0.85.1 routes native manual/automatic compaction through
    // session_before_compact, which the extension vetoes. Rubato's older
    // engine marker set refers to Senpi-only lanes and must not gate this
    // stock adapter.
    requireEngine: options.requireEngine ?? false,
    propagateEnv: options.propagateEnv,
    settingsManager: options.settingsManager,
    env: options.env,
  });
}

export default createContextNotesExtension();
