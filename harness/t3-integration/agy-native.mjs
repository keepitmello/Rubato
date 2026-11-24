// Rubato's rewind and fork on official agy, on agy's own conversation store.
//
// `agy acp` has no ACP method for either, but the language server every `agy acp` process runs
// (it logs "Language server listening on random port at N for HTTP") answers agy's own
// RevertToCascadeStep, ForkConversation and GetCascadeTrajectorySteps over connect-JSON, the
// calls agy's own `/rewind` uses. A cascade id is the ACP session id; RevertToCascadeStep keeps
// steps 0..stepIndex and ForkConversation copies steps 0..forkAtStepIndex.
//
// The GUI never holds a live agy to call: a rewind leaves a cut for the session here (`writeCut`),
// and the approval bridge (agy-acp-approval.mjs) lands it before that session next loads,
// resumes, forks or takes a prompt. Before agy's end of a reply reaches the GUI, the bridge writes
// which tool calls one model response made together (`batches`), so the GUI cuts after the same
// whole batch agy keeps.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AGY_NATIVE_DIR_ENV = 'RUBATO_AGY_NATIVE_DIR';
const SERVICE = 'exa.language_server_pb.LanguageServerService';
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

function sessionFile(dir, kind, sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not an agy session id: ${sessionId}`);
  return path.join(dir, kind, `${sessionId}.json`);
}
function cutFolder(dir, sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not an agy session id: ${sessionId}`);
  return path.join(dir, 'cuts', sessionId);
}
/**
 * A cut's file name: later writes from one process sort after earlier ones, even within one
 * millisecond (`sequence` counts this process's writes).
 */
export const cutFileName = (now, sequence, id) =>
  `${String(now).padStart(15, '0')}-${String(sequence).padStart(9, '0')}-${id}.json`;
let cutSequence = 0;

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/**
 * A cut keeps the session up to one point: `{ throughTime }` keeps every step made by then (the end
 * of a turn that stays), `{ throughToolCallId, batchEnd }` keeps through the batch that tool call
 * is in, which must end at `batchEnd`, the call the GUI cut after. Each write is its own file in
 * the session's folder and the latest one counts, so landing one clears only the files it saw
 * and never a cut written meanwhile.
 */
export async function writeCut(dir, sessionId, keep) {
  if (typeof keep?.throughTime !== 'string' && typeof keep?.throughToolCallId !== 'string')
    throw new Error('A cut keeps through a time or a tool call.');
  const id = randomUUID();
  return writeJson(path.join(cutFolder(dir, sessionId), cutFileName(Date.now(), ++cutSequence, id)),
    { sessionId, keep, id, writtenAt: new Date().toISOString() });
}
/**
 * The session's latest cut and the cut files that stood when it was read; null when none waits.
 * A latest cut that cannot be read fails, rather than letting the session run on uncut.
 */
export async function readCut(dir, sessionId) {
  const folder = cutFolder(dir, sessionId);
  // Only a folder that is not there means no cut; any other failure to look must not read as none.
  const listed = await readdir(folder).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`The rewinds waiting for this conversation could not be read: ${error?.message ?? error}`);
  });
  const names = listed.filter((name) => name.endsWith('.json')).toSorted();
  if (!names.length) return null;
  let cut;
  try { cut = await readJson(path.join(folder, names.at(-1))); } catch {}
  if (!cut?.keep) throw new Error(`The rewind waiting for this conversation could not be read (${names.at(-1)}).`);
  return { ...cut, files: names };
}
/** Clears the files a landed cut was read with; a cut written since then stays. */
export async function clearCut(dir, sessionId, landed) {
  const folder = cutFolder(dir, sessionId);
  await Promise.all((landed?.files ?? []).map((name) => rm(path.join(folder, name), { force: true })));
}

export const writeBatches = async (dir, sessionId, batches) =>
  writeJson(sessionFile(dir, 'batches', sessionId), { sessionId, batches, writtenAt: new Date().toISOString() });
/** The last tool call in `toolCallId`'s batch, as the bridge last saw the session; undefined when unknown. */
export async function batchEnd(dir, sessionId, toolCallId) {
  const saved = await readJson(sessionFile(dir, 'batches', sessionId)).catch(() => null);
  const end = saved?.batches?.[toolCallId];
  return typeof end === 'string' ? end : undefined;
}

/** Where `agy` writes its logs for the given arguments: `--gemini-dir` and `--app-data-dir`, else its defaults. */
export function agyLogDirectory(args, home) {
  const flag = (name) => {
    const at = args.indexOf(name);
    if (at >= 0 && typeof args[at + 1] === 'string') return args[at + 1];
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    return inline?.slice(name.length + 1);
  };
  const geminiDir = flag('--gemini-dir') ?? path.join(home, '.gemini');
  // agy joins the app data folder beneath gemini-dir even when it is absolute.
  const appData = (flag('--app-data-dir') ?? 'antigravity-cli').replace(/^[/\\]+/, '');
  return path.join(geminiDir, appData, 'log');
}

export function languageServerPort(logText) {
  const match = /Language server listening on random port at (\d+) for HTTP\r?\n/.exec(logText);
  return match ? Number(match[1]) : undefined;
}

/** The HTTP port of the language server in agy process `pid`, once its log names one. */
export async function findLanguageServerPort(logDir, pid) {
  const names = await readdir(logDir).catch(() => []);
  const own = names.filter((name) => name.startsWith('acp-server-') && name.endsWith(`-${pid}.log`));
  for (const name of own) {
    const port = languageServerPort(await readFile(path.join(logDir, name), 'utf8').catch(() => ''));
    if (port) return port;
  }
  return undefined;
}

export function languageServerClient(port, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const call = async (method, body) => {
    const response = await fetchImpl(`http://127.0.0.1:${port}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`agy ${method} answered ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    steps: async (cascadeId) => (await call('GetCascadeTrajectorySteps', { cascadeId })).steps ?? [],
    revert: (cascadeId, stepIndex) => call('RevertToCascadeStep', { cascadeId, stepIndex }),
    fork: async (cascadeId, stepIndex) => {
      const answer = await call('ForkConversation', { sourceCascadeId: cascadeId, forkAtStepIndex: stepIndex });
      if (typeof answer.newCascadeId !== 'string') throw new Error('agy did not name the forked conversation.');
      return answer.newCascadeId;
    },
  };
}

const PLANNER = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
const toolCallOf = (step) => (step?.type !== PLANNER ? step?.metadata?.toolCall?.id : undefined);

/** Each tool call → the last tool call its model response made with it, by agy's own steps. */
export function toolBatches(steps) {
  const batches = {};
  let group = null;
  for (const step of steps) {
    if (step?.type === PLANNER) {
      const ids = (step.plannerResponse?.toolCalls ?? []).map((call) => call?.id).filter((id) => typeof id === 'string');
      group = ids.length ? { ids: new Set(ids), last: undefined } : null;
      continue;
    }
    const id = toolCallOf(step);
    if (id === undefined) continue;
    if (group?.ids.has(id)) {
      group.last = id;
      for (const member of group.ids) if (member in batches || member === id) batches[member] = id;
    } else batches[id] = id;
  }
  return batches;
}

/**
 * The last step a cut keeps, or `undefined` when it keeps everything. A time keeps the steps
 * agy made by then; a tool call keeps through the last tool step of its batch.
 */
export function keptThrough(steps, keep) {
  if (typeof keep?.throughTime === 'string') {
    const limit = Date.parse(keep.throughTime);
    if (!Number.isFinite(limit)) throw new Error(`Not a time: ${keep.throughTime}`);
    const first = steps.findIndex((step) => Date.parse(step?.metadata?.createdAt ?? '') > limit);
    if (first < 0) return undefined;
    if (first === 0) throw new Error('The cut keeps none of the conversation.');
    return first - 1;
  }
  const at = steps.findIndex((step) => toolCallOf(step) === keep?.throughToolCallId);
  if (at < 0) throw new Error(`agy has no step for tool call ${keep?.throughToolCallId}.`);
  const end = toolBatches(steps)[keep.throughToolCallId] ?? keep.throughToolCallId;
  if (typeof keep.batchEnd === 'string' && keep.batchEnd !== end)
    throw new Error(`agy's batch for ${keep.throughToolCallId} ends at ${end}, not at ${keep.batchEnd} where the thread was cut.`);
  let last = at;
  steps.forEach((step, index) => { if (toolCallOf(step) === end && index > last) last = index; });
  return last < steps.length - 1 ? last : undefined;
}

const SETTINGS = new Set(['session/set_model', 'session/set_mode', 'session/set_config_option']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The bridge's side of rewind and fork, between the ACP client (T3) and one `agy acp` child.
 * `fromClient` sees each client message before it reaches agy and answers what to send on
 * (the message, a replacement, or null when it was answered here); `fromAgent` sees each agy
 * message and answers what reaches the client (null drops it).
 *
 * - `initialize`: the answer advertises ACP `session/fork` and `_meta.rubato.nativeRewind`.
 * - A cut for a session lands before that session's next load, resume, prompt or fork: agy
 *   reverts it, and an open session is closed and resumed with the client's last model, mode
 *   and options, since a live session keeps the old conversation in memory.
 * - `session/fork` copies the source conversation (to `_meta.rubato.keepThroughTime`, else all
 *   of it) and resumes the copy under the client's request id.
 * - Before agy's usage report or prompt answer reaches the client, and when a session opens, the
 *   tool batches are saved for the GUI.
 * The bridge's own requests to agy, and the updates they cause, never reach the client.
 */
export function createAgyNative({ dir, logDir, pid, toAgent, toClient, prefix,
  languageServer = languageServerClient, languageServerWaitMs = 15_000 }) {
  let sequence = 0, server;
  const ownRequests = new Map(), quiet = new Map(), clientRequests = new Map();
  const open = new Set(), sessionParams = new Map(), sessionSettings = new Map();

  const languageServerReady = async () => {
    if (server) return server;
    const deadline = Date.now() + languageServerWaitMs;
    for (;;) {
      const port = await findLanguageServerPort(logDir, pid);
      if (port) return (server = languageServer(port));
      if (Date.now() > deadline) throw new Error('agy did not report its language server.');
      await sleep(100);
    }
  };
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = `${prefix}native-${++sequence}`;
    ownRequests.set(id, { resolve, reject, method });
    toAgent({ jsonrpc: '2.0', id, method, params });
  });
  const hush = async (sessionId, work) => {
    quiet.set(sessionId, (quiet.get(sessionId) ?? 0) + 1);
    try { return await work(); }
    finally {
      const left = quiet.get(sessionId) - 1;
      if (left) quiet.set(sessionId, left); else quiet.delete(sessionId);
    }
  };
  const resumeParams = (sessionId, fallback) => {
    const known = sessionParams.get(sessionId);
    return { sessionId, cwd: known?.cwd ?? fallback?.cwd ?? process.cwd(), mcpServers: known?.mcpServers ?? [],
      ...(known?.additionalDirectories ? { additionalDirectories: known.additionalDirectories } : {}) };
  };
  const replaySettings = async (sessionId) => {
    for (const setting of sessionSettings.get(sessionId)?.values() ?? []) await ask(setting.method, setting.params);
  };

  /** Lands the waiting cuts for `sessionId`, a newer one written meanwhile too; `request` is the client message they precede. */
  const landCut = (sessionId, request) => hush(sessionId, async () => {
    for (let cut = await readCut(dir, sessionId); cut; cut = await readCut(dir, sessionId)) {
      const wasOpen = open.has(sessionId);
      // The language server comes up with agy's first session; a closed one opens without replay.
      if (!wasOpen) await ask('session/resume', { ...resumeParams(sessionId, request?.params), mcpServers: [] });
      const steps = await (await languageServerReady()).steps(sessionId);
      const last = keptThrough(steps, cut.keep);
      if (last !== undefined) await server.revert(sessionId, last);
      await ask('session/close', { sessionId });
      open.delete(sessionId);
      if (wasOpen) {
        await ask('session/resume', resumeParams(sessionId));
        open.add(sessionId);
        await replaySettings(sessionId);
      }
      await clearCut(dir, sessionId, cut);
    }
  });

  const fork = async (wire) => {
    const { sessionId, cwd, mcpServers = [], _meta } = wire.params ?? {};
    await landCut(sessionId, wire);
    const forkedId = await hush(sessionId, async () => {
      const wasOpen = open.has(sessionId);
      if (!wasOpen) await ask('session/resume', { ...resumeParams(sessionId, wire.params), mcpServers: [] });
      try {
        const steps = await (await languageServerReady()).steps(sessionId);
        if (!steps.length) throw new Error('The conversation has nothing to fork.');
        const through = typeof _meta?.rubato?.keepThroughTime === 'string'
          ? keptThrough(steps, { throughTime: _meta.rubato.keepThroughTime }) : undefined;
        return await server.fork(sessionId, through ?? steps.length - 1);
      } finally {
        if (!wasOpen) await ask('session/close', { sessionId }).catch(() => {});
      }
    });
    const params = { sessionId: forkedId, cwd, mcpServers };
    clientRequests.set(wire.id, { method: 'session/resume', params });
    return { ...wire, method: 'session/resume', params };
  };

  /** Saves the session's batches as agy holds them now; never fails the stream it runs in. */
  const saveBatches = async (sessionId) => {
    if (typeof sessionId !== 'string') return;
    try {
      // An open session means agy has logged its port; look once rather than wait on the stream.
      if (!server) {
        const port = await findLanguageServerPort(logDir, pid);
        if (!port) return;
        server = languageServer(port);
      }
      await writeBatches(dir, sessionId, toolBatches(await server.steps(sessionId)));
    } catch {}
  };

  const fail = (wire, error) => {
    toClient({ jsonrpc: '2.0', id: wire.id, error: { code: -32603,
      message: `Rubato could not rewind or fork the Antigravity conversation: ${error?.message ?? error}` } });
    return null;
  };

  return {
    async fromClient(wire) {
      const method = wire?.method;
      if (!method || wire.id === undefined) return wire;
      const sessionId = wire.params?.sessionId;
      try {
        if (method === 'session/fork') return await fork(wire);
        if ((method === 'session/load' || method === 'session/resume' || method === 'session/prompt') &&
            typeof sessionId === 'string') await landCut(sessionId, wire);
      } catch (error) { return fail(wire, error); }
      if (['initialize', 'session/new', 'session/load', 'session/resume', 'session/prompt', 'session/close'].includes(method) ||
          SETTINGS.has(method))
        clientRequests.set(wire.id, { method, params: wire.params });
      return wire;
    },
    /** What reaches the client for one agy message; a reply's end waits until its batches are saved. */
    async fromAgent(wire) {
      if (wire?.id !== undefined && !wire.method && ownRequests.has(wire.id)) {
        const own = ownRequests.get(wire.id);
        ownRequests.delete(wire.id);
        if (wire.error) own.reject(new Error(`agy ${own.method}: ${wire.error.message ?? JSON.stringify(wire.error)}`));
        else own.resolve(wire.result);
        return null;
      }
      const sessionId = wire?.params?.sessionId;
      if (wire?.method === 'session/update' && typeof sessionId === 'string') {
        if (quiet.has(sessionId)) return null;
        // The GUI may end the turn on this update, so the batches it reads must already be there.
        if (wire.params.update?.sessionUpdate === 'usage_update') await saveBatches(sessionId);
        return wire;
      }
      if (wire?.id === undefined || wire.method || !clientRequests.has(wire.id)) return wire;
      const { method, params } = clientRequests.get(wire.id);
      clientRequests.delete(wire.id);
      if (wire.error) return wire;
      if (SETTINGS.has(method) && typeof params?.sessionId === 'string') {
        // Only what agy took is restored after a cut; a value it refused stays refused.
        const key = method === 'session/set_config_option' ? `${method}:${params.configId}` : method;
        const settings = sessionSettings.get(params.sessionId) ?? new Map();
        settings.set(key, { method, params });
        sessionSettings.set(params.sessionId, settings);
        return wire;
      }
      if (method === 'initialize') {
        const capabilities = wire.result?.agentCapabilities ?? {};
        return { ...wire, result: { ...wire.result, agentCapabilities: { ...capabilities,
          sessionCapabilities: { ...capabilities.sessionCapabilities, fork: {} },
          _meta: { ...capabilities._meta, rubato: { ...capabilities._meta?.rubato, nativeRewind: true } } } } };
      }
      const opened = method === 'session/new' ? wire.result?.sessionId : params?.sessionId;
      if (method === 'session/close') { open.delete(params?.sessionId); return wire; }
      if (method === 'session/prompt') { await saveBatches(params?.sessionId); return wire; }
      if (typeof opened === 'string') {
        open.add(opened);
        // A session opened before the bridge kept batches gets them now; the GUI reads them later.
        languageServerReady().then(() => saveBatches(opened), () => {});
        sessionParams.set(opened, { cwd: params?.cwd, mcpServers: params?.mcpServers ?? [],
          ...(params?.additionalDirectories ? { additionalDirectories: params.additionalDirectories } : {}) });
      }
      return wire;
    },
    close() {
      for (const own of ownRequests.values()) own.reject(new Error('agy stopped.'));
      ownRequests.clear();
    },
  };
}
