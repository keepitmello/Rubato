import { randomUUID } from 'node:crypto';
import { mkdirSync, watch, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { judgeTask, recordSkip } from '../../../packages/schedule-core/src/index.mjs';
import { executeRun, reconcileRun, runTitle } from './runner.mjs';

export const TICK_MS = 15_000;

/**
 * The only executor. Each tick judges every enabled task against the clock (run, or record a
 * skip — never catch up), takes queued run-now requests, and starts their sessions. Store
 * changes wake it at once so "Run now" does not wait for the next tick.
 */
export function createScheduler({ store, engine, now = () => new Date(), tickMs = TICK_MS, log = () => {}, runOptions = {} }) {
  const startedAt = now();
  const inflight = new Map();
  const controller = new AbortController();
  let timer;
  let watcher;
  let ticking;
  let again = false;
  let stopped = false;

  const update = (runId) => (patch) => store.mutate((state) => {
    const row = state.runs.find((run) => run.id === runId);
    if (row) Object.assign(row, patch);
  }).catch((error) => log('run update failed', { runId, error: String(error?.message ?? error) }));

  function writeHeartbeat(at) {
    const file = store.files.scheduler;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, startedAt: startedAt.toISOString(), lastTickAt: at.toISOString() }) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  }

  function launch(task, row, work) {
    const promise = work().catch((error) => log('run crashed', { runId: row.id, error: String(error?.message ?? error) }))
      .finally(() => { inflight.delete(row.id); });
    inflight.set(row.id, { taskId: task?.id ?? row.taskId, promise });
  }

  const newRow = (task, { trigger, scheduledFor, rerunOf = null, at }) => ({
    id: randomUUID(), taskId: task.id, trigger, scheduledFor: scheduledFor?.toISOString() ?? null,
    lastScheduledFor: scheduledFor?.toISOString() ?? null, skipCount: 0, status: 'running', reason: null, detail: null,
    startedAt: at.toISOString(), finishedAt: null, model: task.model, thinking: task.thinking, cwd: task.cwd,
    sessionId: null, serverId: null, title: runTitle(task.name, scheduledFor ?? at), rerunOf,
  });

  async function tickOnce() {
    const at = now();
    const starts = [];
    await store.mutate((state) => {
      const busy = (taskId) => state.runs.some((run) => run.taskId === taskId && run.status === 'running')
        || [...inflight.values()].some((item) => item.taskId === taskId);
      for (const task of state.tasks) {
        if (!task.enabled) continue;
        const verdict = judgeTask(task, { now: at, schedulerStartedAt: startedAt, running: busy(task.id) });
        for (const skip of verdict.skips) {
          recordSkip(state.runs, { taskId: task.id, scheduledFor: skip.scheduledFor, reason: skip.reason, cwd: task.cwd, newId: randomUUID, now: at });
        }
        task.evaluatedThrough = verdict.evaluatedThrough.toISOString();
        if (verdict.disable) task.enabled = false;
        if (verdict.fire) {
          const row = newRow(task, { trigger: 'schedule', scheduledFor: verdict.fire, at });
          state.runs.push(row);
          starts.push({ task: { ...task }, row });
        }
      }
      for (const request of state.requests.splice(0)) {
        const task = state.tasks.find((item) => item.id === request.taskId);
        if (!task || busy(task.id)) continue;
        const row = newRow(task, { trigger: 'manual', scheduledFor: null, rerunOf: request.fromRunId ?? null, at });
        state.runs.push(row);
        starts.push({ task: { ...task }, row });
      }
    });
    for (const { task, row } of starts) {
      log('run due', { runId: row.id, taskId: task.id, trigger: row.trigger, scheduledFor: row.scheduledFor });
      launch(task, row, () => executeRun({ task, row, engine, update: update(row.id), log, signal: controller.signal, ...runOptions }));
    }
    writeHeartbeat(at);
  }

  /** Serialized: a wake during a tick runs one more tick after it. */
  function tick() {
    if (stopped) return Promise.resolve();
    if (ticking) { again = true; return ticking; }
    ticking = (async () => {
      do { again = false; await tickOnce().catch((error) => log('tick failed', { error: String(error?.message ?? error) })); }
      while (again && !stopped);
    })().finally(() => { ticking = undefined; });
    return ticking;
  }

  async function reconcile() {
    const state = store.read();
    for (const row of state.runs.filter((run) => run.status === 'running' && !inflight.has(run.id))) {
      log('reconciling run', { runId: row.id, sessionId: row.sessionId });
      launch(null, row, () => reconcileRun({ row, engine, update: update(row.id), log, signal: controller.signal, ...runOptions }));
    }
  }

  return {
    startedAt,
    inflight,
    tick,
    async start() {
      mkdirSync(store.files.root, { recursive: true, mode: 0o700 });
      writeHeartbeat(startedAt);
      await reconcile();
      await tick();
      const loop = () => { timer = setTimeout(async () => { await tick(); if (!stopped) loop(); }, tickMs); };
      loop();
      let debounce;
      watcher = watch(store.files.root, (_event, name) => {
        if (name !== path.basename(store.files.state)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => { void tick(); }, 100);
      });
    },
    /** Stops ticking. Runs in flight are left to the engine; the next start reconciles them. */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      watcher?.close();
      controller.abort();
      await ticking;
      await Promise.allSettled([...inflight.values()].map((item) => item.promise));
    },
  };
}
