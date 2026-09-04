import { replaceOnce } from "./replace-once.mjs";

export function isCursorExecBridgeSessionUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/cursor-exec-bridge-session.js");
}

const COMMENT_NEEDLE = `the ownership guard in \`Agent.emitExternalEvent\`, and execute a dead run's
 * tool inside the new run.
 */
export function createSessionCursorExecBridge`;

const COMMENT_REPLACEMENT = `the ownership guard in \`Agent.emitExternalEvent\`, and execute a dead run's
 * tool inside the new run.
 *
 * The session id doubles as the conversation lineage id the exec journal keys
 * on. It is the identity that survives a process restart and a resume, which is
 * exactly what a durable duplicate-execution record needs; the run signal is
 * not, because it is recreated per run.
 */
export function createSessionCursorExecBridge`;

const GETTER_NEEDLE = `        getTool: (name) => sessionRef.current?.getRegisteredTool(name),
        preflightToolCall:`;

const GETTER_REPLACEMENT = `        getTool: (name) => sessionRef.current?.getRegisteredTool(name),
        getConversationLineageId: () => sessionRef.current?.sessionId,
        getCwd: () => sessionRef.current?.cwd ?? process.cwd(),
        preflightToolCall:`;

/** #14: session id is the durable conversation lineage the journal keys on. */
export function injectCursorExecBridgeSession(source) {
  let next = replaceOnce(source, COMMENT_NEEDLE, COMMENT_REPLACEMENT, "cursor-exec-bridge-session lineage comment");
  return replaceOnce(next, GETTER_NEEDLE, GETTER_REPLACEMENT, "cursor-exec-bridge-session lineage getter");
}
