import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ScheduleError } from './errors.mjs';
import { describeSchedule, formatNextRun, nextRunAfter, previewSchedule, validateSchedule } from './schedule.mjs';
import { pruneRuns } from './judge.mjs';

// One JSON file holds tasks, run rows and pending run-now requests. Every writer (the
// settings route in the T3 server, the session tool inside the engine, the CLI and the
// scheduler) goes through `mutate`: a short exclusive lock file, then write-and-rename, so a
// reader never sees half a file and `revision` rises on every change.

export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_ID = /^[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;

export function scheduleHome(env = process.env) {
  const override = env.RUBATO_SCHEDULE_HOME?.trim();
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return override ? path.resolve(home, override) : path.join(home, '.rubato', 'schedule');
}

const emptyState = () => ({ version: 1, revision: 0, tasks: [], runs: [], requests: [] });
const invalid = (message, field) => new ScheduleError('invalid', message, { field });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function readJson(file, fallback) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  try { return JSON.parse(text); }
  catch { throw new ScheduleError('corrupt', `The schedule file is not valid JSON: ${file}`); }
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

function directoryOrThrow(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw invalid('Choose a project folder.', 'cwd');
  if (!path.isAbsolute(cwd.trim())) throw invalid('The project folder must be an absolute path.', 'cwd');
  const resolved = path.resolve(cwd.trim());
  let info;
  try { info = statSync(resolved); } catch { throw invalid('That folder does not exist.', 'cwd'); }
  if (!info.isDirectory()) throw invalid('That path is not a folder.', 'cwd');
  return resolved;
}

/** Validates the user-editable fields present in `input`; `partial` allows missing ones. */
export function validateTaskFields(input, { partial = false, now = new Date() } = {}) {
  if (!input || typeof input !== 'object') throw invalid('Task fields are required.');
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  if (has('name') || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw invalid('Give the task a name.', 'name');
    if (name.length > 80) throw invalid('Keep the name under 80 characters.', 'name');
    out.name = name;
  }
  if (has('cwd') || !partial) out.cwd = directoryOrThrow(input.cwd);
  if (has('prompt') || !partial) {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw invalid('Write the prompt the session starts with.', 'prompt');
    if (prompt.length > 20_000) throw invalid('Keep the prompt under 20,000 characters.', 'prompt');
    out.prompt = prompt;
  }
  if (has('model') || (!partial && input.model === null)) {
    const model = input.model === null || input.model === '' ? null : input.model;
    if (model !== null && (typeof model !== 'string' || !MODEL_ID.test(model))) {
      throw invalid('Use a model id like provider/model, or leave it empty for your default model.', 'model');
    }
    out.model = model;
  } else if (!partial) out.model = null;
  if (has('thinking') || (!partial && input.thinking === null)) {
    const thinking = input.thinking === null || input.thinking === '' ? null : input.thinking;
    if (thinking !== null && !THINKING_LEVELS.includes(thinking)) {
      throw invalid(`Thinking level must be one of ${THINKING_LEVELS.join(', ')}.`, 'thinking');
    }
    out.thinking = thinking;
  } else if (!partial) out.thinking = null;
  if (has('schedule') || !partial) out.schedule = validateSchedule(input.schedule, { now });
  if (has('enabled')) {
    if (typeof input.enabled !== 'boolean') throw invalid('enabled must be true or false.', 'enabled');
    out.enabled = input.enabled;
  }
  return out;
}

/** A task by id, exact name (any case), id prefix or unique part of its name. */
export function findTask(tasks, query) {
  if (!query) throw new ScheduleError('invalid', 'Name the task (its name or id).');
  const lower = query.toLowerCase();
  const exact = tasks.filter((task) => task.id === query || task.name.toLowerCase() === lower);
  const matches = exact.length ? exact : tasks.filter((task) => task.id.startsWith(query) || task.name.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new ScheduleError('not-found', `No task matches "${query}".`);
  throw new ScheduleError('invalid', `"${query}" matches ${matches.length} tasks: ${matches.map((task) => task.name).join(', ')}. Use the id.`);
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date, root?: string }} [options]
 */
export function createScheduleStore(options = {}) {
  const env = options.env ?? process.env;
  const clock = options.now ?? (() => new Date());
  const root = options.root ?? scheduleHome(env);
  const files = { root, state: path.join(root, 'state.json'), lock: path.join(root, 'state.lock'),
    scheduler: path.join(root, 'scheduler.json'), logs: path.join(root, 'logs') };

  const read = () => {
    const state = readJson(files.state, null) ?? emptyState();
    if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) {
      throw new ScheduleError('corrupt', `The schedule file has an unknown shape: ${files.state}`);
    }
    state.requests ??= [];
    return state;
  };

  async function acquire() {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(files.lock, 'wx', 0o600);
        writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
        closeSync(fd);
        return () => { try { unlinkSync(files.lock); } catch {} };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let holder = '';
      try { holder = readFileSync(files.lock, 'utf8'); } catch {}
      const [pid, at] = holder.trim().split(/\s+/).map(Number);
      const stale = holder && (!pidAlive(pid) || Date.now() - at > LOCK_STALE_MS);
      if (stale) { try { unlinkSync(files.lock); } catch {} continue; }
      if (Date.now() > deadline) throw new ScheduleError('busy', 'The schedule is busy; try again in a moment.');
      await sleep(20);
    }
  }

  /** Runs `change(state)` under the lock. Writes (and bumps revision) only if state changed. */
  async function mutate(change) {
    const release = await acquire();
    try {
      const state = read();
      const before = JSON.stringify(state);
      const result = await change(state);
      state.runs = pruneRuns(state.runs);
      if (JSON.stringify(state) !== before) {
        state.revision = (Number(state.revision) || 0) + 1;
        writeAtomic(files.state, state);
      }
      return result;
    } finally { release(); }
  }

  function schedulerStatus() {
    const status = readJson(files.scheduler, null);
    const running = Boolean(status && pidAlive(status.pid));
    return { running, pid: running ? status.pid : null, startedAt: status?.startedAt ?? null, lastTickAt: status?.lastTickAt ?? null };
  }

  const findTask = (state, id) => {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new ScheduleError('not-found', 'That task no longer exists.');
    return task;
  };
  const isRunning = (state, id) => state.runs.some((run) => run.taskId === id && run.status === 'running')
    || state.requests.some((request) => request.taskId === id);

  function view(state, task, now = clock()) {
    const { evaluatedThrough: _cursor, ...fields } = task;
    const next = task.enabled ? nextRunAfter(task.schedule, now) : null;
    const lastRun = state.runs.findLast((run) => run.taskId === task.id) ?? null;
    return { ...fields, summary: describeSchedule(task.schedule, { now }), nextRunAt: next?.toISOString() ?? null,
      nextRunLabel: formatNextRun(next, now), lastRun, running: isRunning(state, task.id) };
  }

  return {
    files,
    mutate,
    read,
    schedulerStatus,
    view,
    async list() {
      const state = read();
      const now = clock();
      return { revision: state.revision, scheduler: schedulerStatus(), tasks: state.tasks.map((task) => view(state, task, now)) };
    },
    async get(taskId) {
      const state = read();
      return view(state, findTask(state, taskId));
    },
    async revision() { return read().revision; },
    /** Sentence and next instant for an unsaved schedule; throws ScheduleError like create. */
    preview(schedule, { now = clock() } = {}) { return previewSchedule(schedule, { now }); },
    async runs(taskId, { limit = 100 } = {}) {
      const state = read();
      findTask(state, taskId);
      const runs = state.runs.filter((run) => run.taskId === taskId).reverse().slice(0, Math.max(1, Number(limit) || 100));
      return { revision: state.revision, runs };
    },
    async create(input) {
      const now = clock();
      const fields = validateTaskFields(input, { now });
      return mutate((state) => {
        const at = now.toISOString();
        const task = { id: randomUUID(), name: fields.name, cwd: fields.cwd, prompt: fields.prompt, model: fields.model,
          thinking: fields.thinking, schedule: fields.schedule, enabled: fields.enabled ?? true,
          createdAt: at, updatedAt: at, evaluatedThrough: at };
        state.tasks.push(task);
        return view(state, task, now);
      });
    },
    async update(taskId, patch) {
      const now = clock();
      return mutate((state) => {
        const task = findTask(state, taskId);
        // A form saves every field. A schedule equal to the current one is not an edit: it must
        // not restart judging (a slot due seconds ago would vanish unrecorded), and a finished
        // once-task must stay renamable although its time has passed.
        let input = patch;
        if (patch && typeof patch === 'object' && patch.schedule !== undefined) {
          let same = false;
          try { same = JSON.stringify(validateSchedule(patch.schedule, { now: new Date(0) })) === JSON.stringify(task.schedule); } catch {}
          if (same) { const { schedule: _unchanged, ...rest } = patch; input = rest; }
        }
        const fields = validateTaskFields(input, { partial: true, now });
        const reenabled = fields.enabled === true && !task.enabled;
        if (reenabled && !fields.schedule && task.schedule.kind === 'once') validateSchedule(task.schedule, { now });
        Object.assign(task, fields, { updatedAt: now.toISOString() });
        // Editing the schedule or switching a task back on never reaches into the past.
        if (fields.schedule || reenabled) task.evaluatedThrough = now.toISOString();
        return view(state, task, now);
      });
    },
    async setEnabled(taskId, enabled) { return this.update(taskId, { enabled }); },
    async remove(taskId) {
      return mutate((state) => {
        findTask(state, taskId);
        state.tasks = state.tasks.filter((task) => task.id !== taskId);
        state.runs = state.runs.filter((run) => run.taskId !== taskId);
        state.requests = state.requests.filter((request) => request.taskId !== taskId);
        return { deleted: true };
      });
    },
    async runNow(taskId, { fromRunId = null } = {}) {
      return mutate((state) => {
        findTask(state, taskId);
        if (fromRunId !== null && !state.runs.some((run) => run.id === fromRunId && run.taskId === taskId)) {
          throw new ScheduleError('not-found', 'That run is no longer in the history.');
        }
        if (isRunning(state, taskId)) throw new ScheduleError('already-running', 'This task is already running.');
        if (!schedulerStatus().running) {
          throw new ScheduleError('scheduler-offline', 'The scheduler is not running on this Mac. Start it with `rubato schedule install`.');
        }
        const request = { id: randomUUID(), taskId, fromRunId, requestedAt: clock().toISOString() };
        state.requests.push(request);
        return { requestId: request.id };
      });
    },
  };
}
