// `/rubato/status-board/<action>` on the T3 server lands here (RubatoServiceRoute.ts). The page,
// the sidebar's badge and the Agents panel all ask `read` with the project folders they show;
// one answer serves them all for a second, and an answer the caller already holds comes back
// as `unchanged`, so a poll while nothing moves is a few bytes.
import { createHash } from 'node:crypto';
import { readStatusBoard } from './scan.mjs';

const REUSE_MS = 1_000;
const MAX_CWDS = 64;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const versionOf = (groups) => createHash('sha1').update(JSON.stringify(groups)).digest('hex').slice(0, 16);

export function createStatusBoardService({ read = readStatusBoard, clock = Date.now } = {}) {
  let last = null;
  let pending = null;
  const answer = async (cwds) => {
    const key = cwds.join('\n');
    const now = clock();
    if (last && last.key === key && now - last.at < REUSE_MS) return last.value;
    if (pending && pending.key === key) return pending.promise;
    const promise = read({ cwds, now }).then((board) => {
      const value = { ...board, version: versionOf(board.groups) };
      last = { key, at: now, value };
      return value;
    }).finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { key, promise };
    return promise;
  };
  return {
    async handle(action, input) {
      if (action !== 'read') throw fail(404, 'unknown-action', `Unknown action: ${action}`);
      const cwds = Array.isArray(input.cwds) ? input.cwds.filter((cwd) => typeof cwd === 'string').slice(0, MAX_CWDS).toSorted() : [];
      const board = await answer(cwds);
      if (typeof input.version === 'string' && input.version === board.version) return { now: board.now, version: board.version, unchanged: true };
      return board;
    },
  };
}

export async function handleStatusBoardRequest(service, request) {
  if (request.method !== 'POST') return Response.json({ error: { code: 'method', message: 'Use POST.' } }, { status: 405 });
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  let input;
  try { input = await request.json(); } catch {
    return Response.json({ error: { code: 'bad-request', message: 'Request body must be JSON.' } }, { status: 400 });
  }
  try {
    return Response.json(await service.handle(action, input ?? {}));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return Response.json({ error: { code: error?.code ?? 'failed', message: String(error?.message ?? error) } }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function statusBoardService() {
  shared ??= createStatusBoardService();
  return shared;
}
