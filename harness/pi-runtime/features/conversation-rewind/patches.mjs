// App rewind stays inside the session.
//
// Stock RPC offers only `fork`, which writes a new session file and replaces the
// session. Replacement shuts the old session down, and its running children and
// teams are suspended under the old id, where nothing resumes them. `rewind`
// moves the leaf within the same session tree (Pi's /tree), so the session id,
// its children and the abandoned branch all stay.
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION = "0.86.1";
const IMPORT = 'import { findRewindTarget, REWIND_MARK } from "../../rubato-features/conversation-rewind/rewind.mjs";\n';
const ANCHOR = '            case "get_fork_messages": {';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[conversation-rewind:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[conversation-rewind:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchRpcRewind(source) {
  if (source.includes("findRewindTarget")) throw new Error("[conversation-rewind:rpc] expected pristine feature seam");
  return replaceOnce(IMPORT + source, ANCHOR, `            case "rewind": {
                if (session.isStreaming || session.isCompacting)
                    return error(id, "rewind", "Interrupt the current turn before rewinding");
                const manager = session.sessionManager;
                let targetId;
                try {
                    targetId = findRewindTarget(manager.getBranch(), { keep: command.keep, skip: command.skip });
                }
                catch (failure) {
                    return error(id, "rewind", failure instanceof Error ? failure.message : String(failure));
                }
                if (targetId === null)
                    return success(id, "rewind", { cancelled: false, moved: false, leafId: manager.getLeafId() });
                const from = manager.getLeafId();
                // navigateTree does nothing when asked for the current leaf; give it a tip past it.
                if (targetId === from)
                    manager.appendCustomEntry(REWIND_MARK, { abandoned: true });
                const result = await session.navigateTree(targetId, { summarize: false });
                if (result.cancelled)
                    return success(id, "rewind", { cancelled: true, moved: false, leafId: manager.getLeafId() });
                if (manager.getBranch().some((entry) => entry.id === targetId))
                    return error(id, "rewind", "The rewind did not leave the removed turns");
                // The leaf lives in memory, and a session reopened from its file resumes at
                // its last entry. Writing the landing keeps the rewind across a restart.
                manager.appendCustomEntry(REWIND_MARK, { from });
                return success(id, "rewind", { cancelled: false, moved: true, leafId: manager.getLeafId() });
            }
${ANCHOR}`, "rpc-command");
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/rubato-features/conversation-rewind/rewind.mjs",
    sourcePath: fileURLToPath(new URL("./rewind.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "conversation-rewind:rpc",
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/modes/rpc/rpc-mode.js",
    preimageSha256: "bdd94e753e6d19731d9fb9ea370462d095d64f1e78bddd7651320663fa57c4ff",
    apply: patchRpcRewind,
  }),
]);

export const feature = Object.freeze({ id: "conversation-rewind", patches, files });
export default feature;
