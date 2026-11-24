// @effect-diagnostics nodeBuiltinImport:off -- cuts are small files the agy approval bridge reads.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Rewind and fork on official agy's own conversation store. The GUI cannot reach a live agy, so a
// rewind leaves a cut for the agy session in this folder and the approval bridge
// (harness/t3-integration/agy-acp-approval.mjs over agy-native.mjs) lands it before that session
// next loads, resumes, forks or takes a prompt. The bridge writes back which tool calls one model
// response made together, before that reply's end reaches the GUI. The file shapes are
// agy-native.mjs's `writeCut` and `writeBatches`.

export const AGY_NATIVE_DIR_ENV = "RUBATO_AGY_NATIVE_DIR";
/** What a step rewind's "continue" sends agy, which runs on from the kept tool results. */
export const AGY_STEP_CONTINUE_TEXT = "Continue from the rewound step.";
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

export function agyNativeDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment[AGY_NATIVE_DIR_ENV]?.trim();
  return configured || path.join(os.homedir(), ".rubato", "agy-native");
}

function sessionFile(kind: "batches", sessionId: string, dir: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not an agy session id: ${sessionId}`);
  return path.join(dir, kind, `${sessionId}.json`);
}

/**
 * `throughTime` keeps the steps agy made by then; `throughToolCallId` keeps through that call's
 * batch, which must end at `batchEnd`, the call the thread was cut after (else the bridge refuses).
 */
export type AgyCut =
  | { readonly throughTime: string }
  | { readonly throughToolCallId: string; readonly batchEnd: string };

/**
 * Keeps the agy session through `keep` from its next load, resume, fork or prompt on. Each cut is
 * its own file in the session's folder, named so a later one sorts last and counts.
 */
export async function writeAgyCut(sessionId: string, keep: AgyCut, dir = agyNativeDir()): Promise<void> {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not an agy session id: ${sessionId}`);
  const id = randomUUID();
  // @effect-diagnostics-next-line globalDate:off -- a plain helper outside Effect; the name orders cuts.
  const file = path.join(dir, "cuts", sessionId, `${String(Date.now()).padStart(15, "0")}-${id}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  // @effect-diagnostics-next-line globalDate:off -- a plain helper outside Effect; only a unique name.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    // @effect-diagnostics-next-line globalDate:off -- read by people, not by the bridge.
    `${JSON.stringify({ sessionId, keep, id, writtenAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, file);
}

/** The last tool call in `toolCallId`'s batch as the bridge saw agy make it; undefined when unknown. */
export async function agyBatchEnd(
  sessionId: string,
  toolCallId: string,
  dir = agyNativeDir(),
): Promise<string | undefined> {
  try {
    const saved = JSON.parse(await readFile(sessionFile("batches", sessionId, dir), "utf8")) as {
      batches?: Record<string, unknown>;
    };
    const end = saved.batches?.[toolCallId];
    return typeof end === "string" ? end : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the agy session's `initialize` answer came through the bridge that lands cuts. */
export function agyRewindsNatively(initializeResult: unknown): boolean {
  const capabilities = (initializeResult as { agentCapabilities?: { _meta?: unknown } } | undefined)
    ?.agentCapabilities;
  const meta = capabilities?._meta as { rubato?: { nativeRewind?: unknown } } | undefined;
  return meta?.rubato?.nativeRewind === true;
}
