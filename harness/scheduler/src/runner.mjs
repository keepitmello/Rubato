import { statSync } from 'node:fs';

// One run = one ordinary session in the profile engine, created, prompted and watched to the
// end of its first turn. The engine keeps the conversation (JSONL) and T3 projects it into a
// thread like any other; this side only records the outcome on the run row.
//
// A failure before the session exists leaves `sessionId` null (nothing to open); after it, the
// id stays so the page can still open the thread.

const pad = (value) => String(value).padStart(2, '0');
export function runTitle(taskName, at) {
  return `⏰ ${taskName} · ${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const message = (error) => String(error?.message ?? error ?? 'Unknown error').split('\n')[0].slice(0, 500);
const failure = (reason, detail) => ({ status: 'failed', reason, detail: detail ?? null });
const modelOf = (state) => (state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : null);
const listOf = (value) => (Array.isArray(value) ? value : Array.isArray(value?.messages) ? value.messages : []);

/** Outcome of a finished first turn from its messages: the last assistant reply decides. */
export function verdictFromMessages(messages, { noReply = 'turn-error' } = {}) {
  const reply = listOf(messages).findLast((item) => item?.role === 'assistant');
  if (!reply) return failure(noReply, noReply === 'interrupted' ? 'The run stopped before the session replied.' : 'The session ended without a reply.');
  if (reply.stopReason === 'error') return failure('turn-error', reply.errorMessage ?? 'The model returned an error.');
  if (reply.stopReason === 'aborted') return failure('aborted', reply.errorMessage ?? 'The turn was stopped.');
  return { status: 'success', reason: null, detail: null };
}

async function configure(client, task) {
  if (task.model) {
    const split = task.model.indexOf('/');
    const provider = task.model.slice(0, split);
    const modelId = task.model.slice(split + 1);
    // The engine's own error does not cross the socket (it arrives as "Internal server error"),
    // so say which model is missing before asking for it. "Available" means signed in too.
    const { models } = await client.command({ type: 'get_available_models' }) ?? {};
    if (Array.isArray(models) && !models.some((model) => model?.provider === provider && model?.id === modelId)) {
      throw new Error(`Model ${task.model} is not available (unknown model, or its provider is not signed in).`);
    }
    try { await client.command({ type: 'set_model', provider, modelId }); }
    catch (error) { throw new Error(`Could not select ${task.model}: ${message(error)}`); }
  }
  if (task.thinking) {
    const { levels } = await client.command({ type: 'get_available_thinking_levels' }) ?? {};
    if (Array.isArray(levels) && !levels.includes(task.thinking)) {
      throw new Error(`Thinking level "${task.thinking}" is not available for this model (${levels.join(', ')}).`);
    }
    await client.command({ type: 'set_thinking_level', level: task.thinking });
  }
}

/**
 * Waits for the turn a prompt started to settle. The prompt's reply arrives after preflight,
 * before the agent loop is necessarily streaming, so state alone could read "idle" too early:
 * the settle event (or, for a prompt handled without a turn, a quiet grace) decides.
 */
export async function waitForTurn(client, { startedSequence = 0, quietMs = 5000, pollMs = 1000, signal } = {}) {
  let seen = startedSequence;
  let started = false;
  let settled = false;
  let wake = () => {};
  const unsubscribe = await client.subscribeSession((state) => {
    for (const item of state?.events ?? []) {
      if (item.sequence <= seen) continue;
      seen = item.sequence;
      if (item.event?.type === 'agent_start') started = true;
      if (item.event?.type === 'agent_settled') settled = true;
    }
    wake();
  });
  const since = Date.now();
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Scheduler stopped while waiting');
      const state = await client.command({ type: 'get_state' });
      const idle = !state?.isStreaming && !state?.isCompacting && !(Number(state?.pendingMessageCount) > 0);
      if (idle && (settled || (!started && Date.now() - since >= quietMs))) return state;
      if (!idle) settled = false; // an auto-retry or compaction continued the run
      await new Promise((resolve) => { const timer = setTimeout(resolve, pollMs); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  } finally { await unsubscribe().catch(() => {}); }
}

/**
 * Starts and watches one run. `update(patch)` persists fields onto the run row and must not
 * throw when the task was deleted meanwhile. Always resolves; the verdict is on the row.
 */
export async function executeRun({ task, row, engine, update, log = () => {}, signal, quietMs, pollMs }) {
  try { if (!statSync(task.cwd).isDirectory()) throw new Error('not a folder'); }
  catch { return update({ ...failure('cwd-missing', `Folder not found: ${task.cwd}`), finishedAt: new Date().toISOString() }); }
  let client;
  try { client = await engine.connect(); }
  catch (error) { return update({ ...failure('engine-unavailable', message(error)), finishedAt: new Date().toISOString() }); }
  const finish = (patch) => update({ ...patch, finishedAt: new Date().toISOString() });
  try {
    let created;
    try { created = await client.create({ cwd: task.cwd, title: row.title, titleLocked: true }); }
    catch (error) { return await finish(failure('start-failed', message(error))); }
    await update({ sessionId: created.sessionId, serverId: client.serverId ?? created.serverId ?? null });
    log('run started', { runId: row.id, taskId: task.id, sessionId: created.sessionId });
    try { await client.attach(created.sessionId); }
    catch (error) { return await finish(failure('start-failed', message(error))); }
    try { await configure(client, task); }
    catch (error) { return await finish(failure('model', message(error))); }
    const state = await client.command({ type: 'get_state' });
    await update({ model: modelOf(state), thinking: state?.thinkingLevel ?? null });
    const { sequence = 0 } = await client.snapshot().catch(() => ({}));
    try { await client.command({ type: 'prompt', message: task.prompt }); }
    catch (error) { return await finish(failure(/model|auth|credential|api key|login/i.test(message(error)) ? 'model' : 'turn-error', message(error))); }
    await waitForTurn(client, { startedSequence: sequence, signal, quietMs, pollMs });
    const verdict = verdictFromMessages(await client.command({ type: 'get_messages' }));
    log('run finished', { runId: row.id, status: verdict.status, reason: verdict.reason });
    return await finish(verdict);
  } catch (error) {
    if (signal?.aborted) return undefined; // the next scheduler start reconciles this row
    return await finish(failure('interrupted', message(error)));
  } finally {
    await client.detach().catch(() => {});
    await client.close().catch(() => {});
  }
}

const LIVE = new Set(['running', 'waiting', 'starting']);

/**
 * A row still `running` when the scheduler (re)starts: keep watching the session if the
 * engine still runs it, otherwise judge it from the saved conversation.
 */
export async function reconcileRun({ row, engine, update, log = () => {}, signal, quietMs, pollMs }) {
  const finish = (patch) => update({ ...patch, finishedAt: new Date().toISOString() });
  if (!row.sessionId) return finish(failure('interrupted', 'The scheduler stopped before the session started.'));
  let client;
  try { client = await engine.connect(); }
  catch (error) {
    log('reconcile deferred: engine unavailable', { runId: row.id, error: message(error) });
    return undefined; // try again on the next start; the row stays running
  }
  try {
    const entry = (await client.list()).find((item) => item.sessionId === row.sessionId);
    if (!entry) return await finish(failure('interrupted', 'The session is no longer in the engine.'));
    if (entry.runtimeId && LIVE.has(entry.status)) {
      await client.attach(row.sessionId);
      await waitForTurn(client, { signal, quietMs: 0, pollMs });
      return await finish(verdictFromMessages(await client.command({ type: 'get_messages' }), { noReply: 'interrupted' }));
    }
    return await finish(verdictFromMessages((await client.transcript(row.sessionId))?.messages, { noReply: 'interrupted' }));
  } catch (error) {
    if (signal?.aborted) return undefined;
    return await finish(failure('interrupted', message(error)));
  } finally {
    await client.detach().catch(() => {});
    await client.close().catch(() => {});
  }
}
