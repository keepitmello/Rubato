// Settings › Companion and the rail's Segno button, the server half. The T3 server loads this
// module from the Rubato checkout (next to bridge.mjs) and forwards one action per request. The
// companion's files belong to harness/companion: this page reads and writes the same files the
// engine's keeper and the companion's role prompt read, and never talks to the engine itself.
// Turning the companion on is a saved setting; the engine's keeper picks it up within seconds and
// creates or loads the companion's conversation.
//
// Settings › Companion also shows the Telegram messenger (harness/companion/messenger): the bot it
// talks through, the code that pairs the person's chat, and every message Segno wants to send to
// someone else. Nothing here reaches the engine either; the page writes the same intent and
// decision files the resident messenger reads, and reads back what it did.
//
// The route's `thread` action is not here: finding the T3 thread of a session needs the T3
// server's own bindings (RubatoCompanion.ts answers it).
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const companionFile = path.resolve(here, '..', '..', '..', 'companion', 'companion.mjs');
const messengerFile = path.resolve(here, '..', '..', '..', 'companion', 'messenger', 'store.mjs');
const inboxFile = path.resolve(here, '..', '..', '..', 'companion', 'inbox.mjs');
// Where the engine reads the default pieces from (rubato-pi system-prompt companionDefaultsDir).
const systemPromptFile = path.resolve(here, '..', '..', '..', 'rubato-pi', 'src', 'system-prompt.mjs');

export class CompanionRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{ companion?: object, defaultsDir?: string, env?: NodeJS.ProcessEnv }} [options]
 *   `companion` stands in for harness/companion/companion.mjs; `defaultsDir` for the default
 *   pieces' folder; `env.RUBATO_COMPANION_HOME` moves the companion's files (tests).
 */
export function createCompanionService(options = {}) {
  const env = options.env ?? process.env;
  let loaded;
  const modules = () => (loaded ??= (async () => {
    const companion = options.companion ?? await import(pathToFileURL(companionFile).href);
    const messenger = options.messenger ?? await import(pathToFileURL(messengerFile).href);
    const inbox = options.inbox ?? await import(pathToFileURL(inboxFile).href);
    const defaultsDir = options.defaultsDir
      ?? (await import(pathToFileURL(systemPromptFile).href)).companionDefaultsDir(env);
    return { companion, messenger, inbox, defaultsDir };
  })().catch((error) => {
    loaded = undefined;
    throw new CompanionRequestError(500, 'companion-unavailable', `The companion module could not load: ${error.message}`);
  }));

  const status = (companion) => ({
    settings: companion.readSettings(env),
    sessionId: companion.readState(env).sessionId ?? null,
    home: companion.companionPaths(env).home,
    heartbeatMinutes: companion.HEARTBEAT_MINUTES,
  });
  const invalid = (work) => {
    try { return work(); }
    catch (error) {
      if (error instanceof TypeError) throw new CompanionRequestError(400, 'invalid', error.message);
      throw error;
    }
  };

  function panel(companion, messenger, inbox) {
    const { leads, finished } = companion.readPanel(env);
    // Open inbox items no lead took yet; one with a lead already shows as that lead's row.
    let unassigned = [];
    try {
      const box = inbox.openInbox({ env });
      try {
        unassigned = box.list({ status: 'open' }).filter((item) => !item.leadSessionId)
          .map((item) => ({ id: item.id, title: item.title, source: item.source, reporter: item.reporter ?? null,
            status: item.status, createdAt: item.createdAt }));
      } finally { box.close(); }
    } catch { /* no inbox yet, or this Node has no SQLite: the panel goes on without it */ }
    const held = messenger.listOutbox(env).filter((row) => row.state === 'held')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((row) => ({ id: row.id, text: row.text, createdAt: row.createdAt,
        to: row.target === 'user' ? null : { chatId: row.target.chatId, name: row.target.name ?? null } }));
    return { leads, finished, held, inbox: unassigned };
  }

  async function handle(action, input) {
    const { companion, messenger, inbox, defaultsDir } = await modules();
    switch (action) {
      case 'status':
        return status(companion);
      case 'save-settings':
        if (!input.patch || typeof input.patch !== 'object') throw new CompanionRequestError(400, 'invalid', 'patch is missing.');
        invalid(() => companion.writeSettings(input.patch, env));
        return status(companion);
      case 'telegram':
        return { telegram: messenger.messengerStatus(env) };
      case 'telegram-settings':
        if (!input.patch || typeof input.patch !== 'object') throw new CompanionRequestError(400, 'invalid', 'patch is missing.');
        invalid(() => messenger.writeMessengerSettings(input.patch, env));
        return { telegram: messenger.messengerStatus(env) };
      case 'telegram-pair':
        messenger.writeIntent({ action: 'pair' }, env);
        return { telegram: messenger.messengerStatus(env) };
      case 'telegram-unpair':
        messenger.writeIntent({ action: 'unpair' }, env);
        return { telegram: messenger.messengerStatus(env) };
      case 'telegram-create-bot':
        messenger.writeIntent({ action: 'create-bot',
          ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
          ...(typeof input.username === 'string' && input.username.trim() ? { username: input.username.trim() } : {}) }, env);
        return { telegram: messenger.messengerStatus(env) };
      case 'telegram-decide':
        if (typeof input.id !== 'string' || !input.id) throw new CompanionRequestError(400, 'invalid', 'id is missing.');
        invalid(() => messenger.writeDecision(input.id, input.decision,
          { by: 'app', ...(input.text === undefined ? {} : { text: input.text }) }, env));
        return { telegram: messenger.messengerStatus(env) };
      // The task panel beside Segno's chat: what it follows (the keeper's panel.json) and the
      // messages to other people that wait for the person.
      case 'panel':
        return panel(companion, messenger, inbox);
      // Segno's art for its space, as a data URL (the route answers JSON to authenticated calls).
      case 'art': {
        const file = companion.stageArtFile(env);
        const data = await readFile(file);
        const mime = file.endsWith('.png') ? 'image/png' : 'image/webp';
        return { art: { url: `data:${mime};base64,${data.toString('base64')}`, version: (await stat(file)).mtimeMs } };
      }
      // Segno's inbox: the issue list the Segno space shows and the daily report reads.
      case 'inbox': {
        const box = inbox.openInbox({ env });
        try {
          return { inbox: { path: box.path,
            items: box.list({ status: input.status ?? 'open', ...(input.source ? { source: String(input.source) } : {}),
              ...(input.limit ? { limit: Number(input.limit) } : {}) }),
            counts: box.counts() } };
        } finally { box.close(); }
      }
      case 'pieces':
        return { pieces: companion.readPieces({ defaultsDir, env }) };
      case 'save-piece':
        if (typeof input.id !== 'string') throw new CompanionRequestError(400, 'invalid', 'id is missing.');
        invalid(() => companion.writePiece(input.id, input.text, { defaultsDir, env }));
        return { pieces: companion.readPieces({ defaultsDir, env }) };
      default:
        throw new CompanionRequestError(404, 'unknown-action', `Unknown action: ${action}`);
    }
  }
  return { handle };
}

export async function handleCompanionRequest(service, request) {
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
    const known = error instanceof CompanionRequestError;
    return Response.json({ error: { code: known ? error.code : 'failed', message: error instanceof Error ? error.message : String(error) } },
      { status: known ? error.status : 500 });
  }
}

let shared;
/** The instance the T3 server uses. */
export function companionService() {
  shared ??= createCompanionService();
  return shared;
}
