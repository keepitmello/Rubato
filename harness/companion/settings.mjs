// Segno's settings, changed by talking to Segno (intent companion-segno rev 8, user item c5ba3d77:
// "모든 설정은 세뇨랑 직접 얘기해서 간편하게 변경이 돼야하고 세뇨도 그거에 대해서 모두 알고있어야 함").
//
// The companion's `companion_settings` tool reaches this through the engine's session link. It reads
// and writes through the very code Settings › Companion uses (t3-integration companion/service.mjs
// `handle`), so there is one schema and one set of checks; the Settings tab reads the same files and
// shows what a conversation changed. What each setting means is the companion-settings skill's.
//
// Only the user changes a setting. The run the tool is called from must have been opened by the
// user: their message in the app or in their paired Telegram chat. Another person's message, another
// conversation, Rubato's clock, or work one of those started cannot — enforced here, from the
// transcript (origin.mjs). Its authority is separate from any remembered reply destination.
//
// The Telegram bot token and the Fish Audio key are plain settings like the rest (user items 0fc61da6,
// 0020edac: Rubato runs on the user's own computer). While the product runs no Telegram
// (messenger/store.mjs TELEGRAM_ENABLED) none of the Telegram settings is shown or changed here.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basePiecePath, clearPersonaReviewRequest, companionPaths, personalPiecePath, readPersonaReviewRequest, readSettings, readState } from './companion.mjs';
import { TELEGRAM_ENABLED, messengerPaths, readMessengerSettings } from './messenger/store.mjs';
import { locateTranscript } from './messenger/sync.mjs';
import { originAt } from './origin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceFile = path.resolve(here, '..', 't3-integration', 'src', 'companion', 'service.mjs');

export const SETTINGS_ACTIONS = Object.freeze(['show', 'change']);
const PAIRING = new Set(['pair', 'unpair']);

export class SettingsRefused extends Error {
  constructor(code, message) { super(message); this.name = 'SettingsRefused'; this.code = code; }
}

/** Whether the input or recorded work that called the tool belongs to the user. */
export function isUserOrigin(trigger) {
  if (trigger?.unverified === true) return false;
  return trigger?.kind === 'app' || (trigger?.kind === 'channel' && trigger.isUser === true);
}

/** What opened the companion's current run, read from its transcript. */
export async function currentOrigin({ sessionsDir, sessionId }) {
  const file = await locateTranscript(sessionsDir, sessionId);
  if (!file) return { kind: 'unknown' };
  return originAt(file);
}

async function defaultService(env) {
  const { createCompanionService } = await import(pathToFileURL(serviceFile).href);
  return createCompanionService({ env });
}

/** Everything Segno can know about its settings now; secrets only as whether they are set. */
export async function settingsView(service, { showPairingCode = false, telegram: withTelegram = TELEGRAM_ENABLED } = {}) {
  const status = await service.handle('status', {});
  const { pieces } = await service.handle('pieces', {});
  return {
    companion: status.settings,
    choices: { heartbeatEveryMinutes: status.heartbeatMinutes },
    ...(withTelegram ? { telegram: await telegramView(service, { showPairingCode }) } : {}),
    pieces: pieces.map((piece) => ({ id: piece.id, title: piece.title, purpose: piece.description, editable: piece.editable,
      personal: piece.personalText !== undefined,
      ...(piece.defaultChanged ? { defaultChanged: true } : {}) })),
  };
}

async function telegramView(service, { showPairingCode }) {
  const { telegram } = await service.handle('telegram', {});
  const pairing = telegram.pairing ?? { status: 'unpaired' };
  return {
      settings: telegram.settings,
      bot: telegram.bot,
      // How the last request to the messenger went (a token Telegram refused says why here).
      ...(telegram.handoff?.result ? { lastRequest: { result: telegram.handoff.result, ...(telegram.handoff.error ? { error: telegram.handoff.error } : {}) } } : {}),
      fishKey: telegram.fishKey ?? null,
      pairing: { status: pairing.status, ...(pairing.chat?.name ? { chat: pairing.chat.name } : {}),
        ...(showPairingCode && pairing.code ? { code: pairing.code } : {}) },
      waitingForApproval: (telegram.waiting ?? []).length,
  };
}

/** The text of one prompt piece: the person's version if they have one, else the default. */
async function pieceText(service, id) {
  const { pieces } = await service.handle('pieces', {});
  const piece = pieces.find((item) => item.id === id);
  if (!piece) throw new SettingsRefused('invalid', `No prompt piece is called ${id}`);
  return { id, editable: piece.editable, personal: piece.personalText !== undefined, text: piece.personalText ?? piece.defaultText };
}

/**
 * Fields of a patch the settings do not have: the current settings, as the page's own code reads
 * them, are the shape; a field outside it would be dropped silently, so it is refused.
 */
export function unknownFields(patch, shape, prefix = '') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [];
  const out = [];
  for (const [key, value] of Object.entries(patch)) {
    const name = `${prefix}${key}`;
    if (!shape || typeof shape !== 'object' || !(key in shape)) { out.push(name); continue; }
    const inner = shape[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && inner && typeof inner === 'object' && !Array.isArray(inner))
      out.push(...unknownFields(value, inner, `${name}.`));
  }
  return out;
}

/** A file's bytes now, or undefined when it does not exist. */
const bytesOf = (file) => (existsSync(file) ? readFileSync(file) : undefined);
const same = (a, b) => (a === undefined ? b === undefined : b !== undefined && a.equals(b));

/**
 * Undo for one change: each step names the files it writes; `before` keeps them as they were and
 * `after` as that step left them. A refusal puts back only files this change wrote and nobody wrote
 * since — a save the Settings page made meanwhile, to the same file or another, stays.
 */
function undoLog(env) {
  const steps = [];
  const reviewAsked = readPersonaReviewRequest(env) !== undefined;
  let reviewed = false;
  return {
    async step(files, work) {
      const entry = files.map((file) => ({ file, before: bytesOf(file) }));
      steps.push(...entry);
      // A step that fails halfway (one of its files written, the next refused) is undone too: what
      // it left is taken as its own.
      try { await work(); }
      finally { for (const item of entry) item.after = bytesOf(item.file); }
    },
    reviewed() { reviewed = true; },
    restore() {
      for (const { file, before, after } of [...steps].reverse()) {
        try {
          if (!same(bytesOf(file), after)) continue;
          if (before === undefined) rmSync(file, { force: true });
          else writeFileSync(file, before, { mode: 0o600 });
        } catch { /* a file that cannot be put back was not written either */ }
      }
      if (reviewed && !reviewAsked) try { clearPersonaReviewRequest(env); } catch { /* nothing to undo */ }
    },
  };
}

/**
 * Applies one change through the Settings page's own actions, each validated there. The checks this
 * module can make alone (unknown fields, pairing, piece shape) run before anything is written; the
 * page's own checks run as each part is written. When a part is refused or fails, what this change
 * wrote is put back, except where someone else (the Settings page) has written the same file since:
 * their save is kept, and with it whatever of this change that file still holds. This is undo of our
 * own writes, not a transaction. A Telegram request (the bot token, pairing) is one per change and
 * goes last, since the messenger carries it out after this answers.
 */
const TELEGRAM_KEYS = Object.freeze(['telegram', 'pairing', 'botToken', 'fishKey']);

async function applyChange(service, change, env, { telegram = TELEGRAM_ENABLED } = {}) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new SettingsRefused('invalid', 'change must be an object');
  const offered = Object.keys(change).filter((key) => TELEGRAM_KEYS.includes(key));
  if (!telegram && offered.length)
    throw new SettingsRefused('invalid', `Telegram is off in Rubato for now, so there is nothing to change in ${offered.join(', ')}`);
  const known = new Set(['companion', 'piece', 'personaReview', ...TELEGRAM_KEYS]);
  const unknown = Object.keys(change).filter((key) => !known.has(key));
  if (change.companion !== undefined) unknown.push(...unknownFields(change.companion, readSettings(env), 'companion.'));
  if (change.telegram !== undefined) unknown.push(...unknownFields(change.telegram, readMessengerSettings(env), 'telegram.'));
  if (unknown.length) throw new SettingsRefused('invalid', `Not a setting: ${unknown.join(', ')}`);
  if (change.pairing !== undefined && !PAIRING.has(change.pairing)) throw new SettingsRefused('invalid', "pairing is 'pair' or 'unpair'");
  if (change.botToken !== undefined && (typeof change.botToken !== 'string' || !change.botToken.trim()))
    throw new SettingsRefused('invalid', 'botToken is the token @BotFather gave');
  if (change.botToken !== undefined && change.pairing !== undefined)
    throw new SettingsRefused('invalid', 'Set the bot token first; pair in the next change');
  if (change.piece !== undefined && (!change.piece || typeof change.piece !== 'object' || typeof change.piece.id !== 'string'))
    throw new SettingsRefused('invalid', 'piece needs an id and its text');
  if (change.personaReview !== undefined && change.personaReview !== true) throw new SettingsRefused('invalid', 'personaReview is true');

  const applied = [];
  const undo = undoLog(env);
  const paths = { companion: companionPaths(env).settings, messenger: messengerPaths(env).settings,
    fishKey: messengerPaths(env).fishKey, intent: messengerPaths(env).intent };
  const pieceFiles = (id) => { try { return [personalPiecePath(env, id), basePiecePath(env, id)]; } catch { return []; } };
  try {
    if (change.companion !== undefined) {
      await undo.step([paths.companion], () => service.handle('save-settings', { patch: change.companion }));
      applied.push('companion');
    }
    if (change.telegram !== undefined) {
      await undo.step([paths.messenger], () => service.handle('telegram-settings', { patch: change.telegram }));
      applied.push('telegram');
    }
    if (change.fishKey !== undefined) {
      await undo.step([paths.fishKey], () => service.handle('voice-key', { key: change.fishKey === null ? null : String(change.fishKey) }));
      applied.push(change.fishKey === null ? 'fishKey removed' : 'fishKey');
    }
    if (change.piece !== undefined) {
      await undo.step(pieceFiles(change.piece.id), () => service.handle('save-piece', { id: change.piece.id, text: change.piece.text ?? '' }));
      applied.push(`piece:${change.piece.id}`);
    }
    // The Telegram request goes last: the messenger acts on it after this answers, so nothing can
    // be refused after it is written.
    if (change.botToken !== undefined) {
      // The messenger checks it with Telegram before keeping it; `show` then has the bot's name or the reason.
      await undo.step([paths.intent], () => service.handle('telegram-set-token', { token: change.botToken.trim() }));
      applied.push('botToken (Telegram checks it; show tells how it went)');
    }
    if (change.pairing !== undefined) {
      await undo.step([paths.intent], () => service.handle(change.pairing === 'pair' ? 'telegram-pair' : 'telegram-unpair', {}));
      applied.push(`pairing:${change.pairing}`);
    }
    if (change.personaReview === true) {
      undo.reviewed();
      await service.handle('review-persona', {});
      applied.push('personaReview');
    }
  } catch (error) {
    undo.restore();
    throw error;
  }
  if (!applied.length) throw new SettingsRefused('invalid', 'Nothing to change');
  return applied;
}

/**
 * The tool's one entry. `request` = { action: 'show' | 'change', piece?: id (show one piece's text),
 * change?: { companion?, telegram?, pairing?, piece?, personaReview? } }.
 * `sessionId` is the calling conversation, which must be the companion's.
 */
export async function companionSettings({ sessionId, sessionsDir, request = {}, env = process.env, service, origin,
  telegram = env.RUBATO_COMPANION_TELEGRAM === '1' || TELEGRAM_ENABLED } = {}) {
  const companionId = readState(env).sessionId;
  if (!sessionId || sessionId !== companionId) throw new SettingsRefused('not-companion', "Only Segno's own conversation has settings to change");
  const action = request.action ?? 'show';
  if (!SETTINGS_ACTIONS.includes(action)) throw new SettingsRefused('invalid', `action is one of ${SETTINGS_ACTIONS.join(', ')}`);
  const settings = service ?? await defaultService(env);
  const from = origin ?? await currentOrigin({ sessionsDir, sessionId });
  const byUser = isUserOrigin(from);
  if (action === 'show') {
    if (typeof request.piece === 'string') return { piece: await pieceText(settings, request.piece) };
    return { settings: await settingsView(settings, { showPairingCode: byUser, telegram }) };
  }
  if (!byUser) {
    throw new SettingsRefused('not-the-user', telegram
      ? 'Only the user changes settings: this turn was not opened by their message in the app or their Telegram chat'
      : 'Only the user changes settings: this turn was not opened by their message in the app');
  }
  try {
    const applied = await applyChange(settings, request.change, env, { telegram });
    return { applied, settings: await settingsView(settings, { showPairingCode: true, telegram }) };
  } catch (error) {
    if (error instanceof SettingsRefused) throw error;
    // The page's own validation answers with its message (CompanionRequestError 400 'invalid').
    if (error?.code === 'invalid') throw new SettingsRefused('invalid', error.message);
    throw error;
  }
}
