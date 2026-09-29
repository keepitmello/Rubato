// Settings > Scheduled Tasks, the server half. The T3 server loads this module
// from the Rubato checkout (next to bridge.mjs) and forwards one action per
// request. Tasks, runs and the schedule sentence all come from
// @rubato/schedule-core, the store the session tool, the CLI and the scheduler
// daemon share: this page reads and writes the same file they do, and never
// runs anything itself — "run now" leaves a request the daemon picks up.
//
// The route's `thread` action is not here: finding the T3 thread of a session
// needs the T3 server's own bindings (RubatoSchedule.ts answers it).
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreFile = path.resolve(here, '..', '..', '..', '..', 'packages', 'schedule-core', 'src', 'index.mjs');

export class ScheduleRequestError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
const bad = (message, field) => new ScheduleRequestError(400, 'invalid', message, field);

// The store's own codes, and what they mean for HTTP.
const STATUS = {
  invalid: 400,
  'schedule-unsupported': 400,
  'schedule-in-past': 400,
  'not-found': 404,
  'already-running': 409,
  'scheduler-offline': 409,
  busy: 503,
  corrupt: 500,
};

function need(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw bad(`${name} is missing.`, name);
  return value;
}

/**
 * @param {{ core?: object, env?: NodeJS.ProcessEnv }} [options]
 *   `core` stands in for @rubato/schedule-core; `env.RUBATO_SCHEDULE_HOME` moves the store (tests).
 */
export function createScheduleService(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? homedir();
  let loaded;
  const core = () => (loaded ??= options.core
    ? Promise.resolve(options.core)
    : import(pathToFileURL(coreFile).href).catch((error) => {
      loaded = undefined;
      throw new ScheduleRequestError(500, 'schedule-unavailable', `The schedule store could not load: ${error.message}`);
    }));
  let store;
  const open = async () => (store ??= (await core()).createScheduleStore({ env }));

  // Task views arrive with the store's own summary and next-run label: the same
  // words the CLI and the session tool print.
  async function handle(action, input) {
    const store = await open();
    switch (action) {
      case 'list':
        return { ...(await store.list()), home };
      case 'revision':
        return { revision: await store.revision() };
      case 'runs':
        return store.runs(need(input.taskId, 'taskId'), typeof input.limit === 'number' ? { limit: input.limit } : {});
      case 'create':
        if (!input.task || typeof input.task !== 'object') throw bad('task is missing.');
        return store.create(input.task);
      case 'update':
        if (!input.patch || typeof input.patch !== 'object') throw bad('patch is missing.');
        return store.update(need(input.taskId, 'taskId'), input.patch);
      case 'set-enabled':
        if (typeof input.enabled !== 'boolean') throw bad('enabled must be true or false.');
        return store.setEnabled(need(input.taskId, 'taskId'), input.enabled);
      case 'delete':
        return store.remove(need(input.taskId, 'taskId'));
      case 'run-now':
        return store.runNow(need(input.taskId, 'taskId'),
          typeof input.fromRunId === 'string' ? { fromRunId: input.fromRunId } : {});
      case 'preview':
        if (!input.schedule || typeof input.schedule !== 'object') throw bad('schedule is missing.', 'schedule');
        return store.preview(input.schedule);
      default:
        throw new ScheduleRequestError(404, 'unknown-action', `Unknown action: ${action}`);
    }
  }
  return { handle };
}

function errorOf(error) {
  if (error instanceof ScheduleRequestError)
    return { status: error.status, body: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } };
  // ScheduleError from the store: a code it names, a user-facing message, maybe the field.
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code in STATUS)
    return {
      status: STATUS[error.code],
      body: typeof error.toJSON === 'function' ? error.toJSON() : { code: error.code, message: error.message },
    };
  return { status: 500, body: { code: 'failed', message: error instanceof Error ? error.message : String(error) } };
}

export async function handleScheduleRequest(service, request) {
  if (request.method !== 'POST')
    return Response.json({ error: { code: 'method', message: 'Use POST.' } }, { status: 405 });
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  let input;
  try { input = await request.json(); } catch {
    return Response.json({ error: { code: 'bad-request', message: 'Request body must be JSON.' } }, { status: 400 });
  }
  try {
    return Response.json(await service.handle(action, input ?? {}));
  } catch (error) {
    const { status, body } = errorOf(error);
    return Response.json({ error: body }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function scheduleService() {
  shared ??= createScheduleService();
  return shared;
}
