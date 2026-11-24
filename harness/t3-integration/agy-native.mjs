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
// resumes, forks or takes a prompt. After each prompt the bridge writes which tool calls one model
// response made together (`batches`), so the GUI can cut after a whole batch.
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AGY_NATIVE_DIR_ENV = 'RUBATO_AGY_NATIVE_DIR';
const SERVICE = 'exa.language_server_pb.LanguageServerService';
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

function sessionFile(dir, kind, sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not an agy session id: ${sessionId}`);
  return path.join(dir, kind, `${sessionId}.json`);
}

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
 * of a turn that stays), `{ throughToolCallId }` keeps through the batch that tool call is in.
 * A later cut replaces an earlier one that has not landed.
 */
export async function writeCut(dir, sessionId, keep) {
  if (typeof keep?.throughTime !== 'string' && typeof keep?.throughToolCallId !== 'string')
    throw new Error('A cut keeps through a time or a tool call.');
  return writeJson(sessionFile(dir, 'cuts', sessionId), { sessionId, keep, writtenAt: new Date().toISOString() });
}
export const readCut = async (dir, sessionId) => readJson(sessionFile(dir, 'cuts', sessionId));
export const clearCut = async (dir, sessionId) => rm(sessionFile(dir, 'cuts', sessionId), { force: true });

export const writeBatches = async (dir, sessionId, batches) =>
  writeJson(sessionFile(dir, 'batches', sessionId), { sessionId, batches, writtenAt: new Date().toISOString() });
/** The last tool call in `toolCallId`'s batch, as the bridge last saw the session; itself when unknown. */
export async function batchEnd(dir, sessionId, toolCallId) {
  const saved = await readJson(sessionFile(dir, 'batches', sessionId)).catch(() => null);
  const end = saved?.batches?.[toolCallId];
  return typeof end === 'string' ? end : toolCallId;
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
 * - After a prompt, and when agy reports usage, the tool batches are saved for the GUI.
 * The bridge's own requests to agy, and the updates they cause, never reach the client.
 */
export function createAgyNative({ dir, logDir, pid, toAgent, toClient, prefix,
  languageServer = languageServerClient, languageServerWaitMs = 15_000 }) {
  let sequence = 0, server;
  const ownRequests = new Map(), quiet = new Map(), clientRequests = new Map();
  const open = new Set(), sessionParams = new Map(), sessionSettings = new Map(), batchTimers = new Map();

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

  /** Lands a waiting cut for `sessionId`; `request` is the client message it precedes. */
  const landCut = (sessionId, request) => hush(sessionId, async () => {
    const cut = await readCut(dir, sessionId);
    if (!cut) return;
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
    await clearCut(dir, sessionId);
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

  const saveBatches = (sessionId) => {
    clearTimeout(batchTimers.get(sessionId));
    batchTimers.set(sessionId, setTimeout(() => {
      batchTimers.delete(sessionId);
      languageServerReady()
        .then((ready) => ready.steps(sessionId))
        .then((steps) => writeBatches(dir, sessionId, toolBatches(steps)))
        .catch(() => {});
    }, 500));
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
        if (SETTINGS.has(method) && typeof sessionId === 'string') {
          const key = method === 'session/set_config_option' ? `${method}:${wire.params.configId}` : method;
          const settings = sessionSettings.get(sessionId) ?? new Map();
          settings.set(key, { method, params: wire.params });
          sessionSettings.set(sessionId, settings);
        }
        if ((method === 'session/load' || method === 'session/resume' || method === 'session/prompt') &&
            typeof sessionId === 'string') await landCut(sessionId, wire);
      } catch (error) { return fail(wire, error); }
      if (['initialize', 'session/new', 'session/load', 'session/resume', 'session/prompt', 'session/close'].includes(method))
        clientRequests.set(wire.id, { method, params: wire.params });
      return wire;
    },
    fromAgent(wire) {
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
        if (wire.params.update?.sessionUpdate === 'usage_update') saveBatches(sessionId);
        return wire;
      }
      if (wire?.id === undefined || wire.method || !clientRequests.has(wire.id)) return wire;
      const { method, params } = clientRequests.get(wire.id);
      clientRequests.delete(wire.id);
      if (wire.error) return wire;
      if (method === 'initialize') {
        const capabilities = wire.result?.agentCapabilities ?? {};
        return { ...wire, result: { ...wire.result, agentCapabilities: { ...capabilities,
          sessionCapabilities: { ...capabilities.sessionCapabilities, fork: {} },
          _meta: { ...capabilities._meta, rubato: { ...capabilities._meta?.rubato, nativeRewind: true } } } } };
      }
      const opened = method === 'session/new' ? wire.result?.sessionId : params?.sessionId;
      if (method === 'session/close') { open.delete(params?.sessionId); return wire; }
      if (method === 'session/prompt') { saveBatches(params?.sessionId); return wire; }
      if (typeof opened === 'string') {
        open.add(opened);
        sessionParams.set(opened, { cwd: params?.cwd, mcpServers: params?.mcpServers ?? [],
          ...(params?.additionalDirectories ? { additionalDirectories: params.additionalDirectories } : {}) });
      }
      return wire;
    },
    close() {
      for (const timer of batchTimers.values()) clearTimeout(timer);
      for (const own of ownRequests.values()) own.reject(new Error('agy stopped.'));
      ownRequests.clear();
    },
  };
}
