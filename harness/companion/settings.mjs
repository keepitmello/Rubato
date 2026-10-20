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
// transcript, with the same run rule the app and Telegram use (messenger/sync.mjs).
//
// Secrets never pass through a conversation: what is typed to Segno is kept in its transcript and
// sent to its model. The Telegram bot token and the Fish Audio key are entered in Settings ›
// Companion only; the tool says whether they are set, never what they are.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readState } from './companion.mjs';
import { locateTranscript, runAt } from './messenger/sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceFile = path.resolve(here, '..', 't3-integration', 'src', 'companion', 'service.mjs');

export const SETTINGS_ACTIONS = Object.freeze(['show', 'change']);
const PAIRING = new Set(['pair', 'unpair']);

export class SettingsRefused extends Error {
  constructor(code, message) { super(message); this.name = 'SettingsRefused'; this.code = code; }
}

/** Whether the run that called the tool belongs to the user (sync.mjs triggers). */
export function isUserOrigin(trigger) {
  return trigger?.kind === 'app' || (trigger?.kind === 'channel' && trigger.isUser === true);
}

/** What opened the companion's current run, read from its transcript. */
export async function currentOrigin({ sessionsDir, sessionId }) {
  const file = await locateTranscript(sessionsDir, sessionId);
  if (!file) return { kind: 'unknown' };
  const { run } = await runAt(file, { companionSessionId: sessionId });
  return run.trigger ?? { kind: 'unknown' };
}

async function defaultService(env) {
  const { createCompanionService } = await import(pathToFileURL(serviceFile).href);
  return createCompanionService({ env });
}

/** Everything Segno can know about its settings now; secrets only as whether they are set. */
export async function settingsView(service, { showPairingCode = false } = {}) {
  const status = await service.handle('status', {});
  const { telegram } = await service.handle('telegram', {});
  const { pieces } = await service.handle('pieces', {});
  const pairing = telegram.pairing ?? { status: 'unpaired' };
  return {
    companion: status.settings,
    choices: { heartbeatEveryMinutes: status.heartbeatMinutes },
    telegram: {
      settings: telegram.settings,
      bot: { tokenSet: Boolean(telegram.bot?.masked), ...(telegram.bot?.username ? { username: telegram.bot.username } : {}) },
      pairing: { status: pairing.status, ...(pairing.chat?.name ? { chat: pairing.chat.name } : {}),
        ...(showPairingCode && pairing.code ? { code: pairing.code } : {}) },
      waitingForApproval: (telegram.waiting ?? []).length,
    },
    pieces: pieces.map((piece) => ({ id: piece.id, editable: piece.editable, personal: piece.personalText !== undefined,
      ...(piece.defaultChanged ? { defaultChanged: true } : {}) })),
  };
}

/** The text of one prompt piece: the person's version if they have one, else the default. */
async function pieceText(service, id) {
  const { pieces } = await service.handle('pieces', {});
  const piece = pieces.find((item) => item.id === id);
  if (!piece) throw new SettingsRefused('invalid', `No prompt piece is called ${id}`);
  return { id, editable: piece.editable, personal: piece.personalText !== undefined, text: piece.personalText ?? piece.defaultText };
}

/** Applies one change through the Settings page's own actions, each validated there. */
async function applyChange(service, change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new SettingsRefused('invalid', 'change must be an object');
  const known = new Set(['companion', 'telegram', 'pairing', 'piece', 'personaReview']);
  const unknown = Object.keys(change).filter((key) => !known.has(key));
  if (unknown.length) throw new SettingsRefused('invalid', `Not a setting this tool changes: ${unknown.join(', ')}`);
  if (change.telegram && typeof change.telegram === 'object') {
    for (const secret of ['token', 'secret', 'fishApiKey', 'apiKey'])
      if (secret in change.telegram) throw new SettingsRefused('secret', 'Keys and tokens are entered in Settings › Companion, never in a conversation');
  }
  const applied = [];
  if (change.companion !== undefined) { await service.handle('save-settings', { patch: change.companion }); applied.push('companion'); }
  if (change.telegram !== undefined) { await service.handle('telegram-settings', { patch: change.telegram }); applied.push('telegram'); }
  if (change.pairing !== undefined) {
    if (!PAIRING.has(change.pairing)) throw new SettingsRefused('invalid', "pairing is 'pair' or 'unpair'");
    await service.handle(change.pairing === 'pair' ? 'telegram-pair' : 'telegram-unpair', {});
    applied.push(`pairing:${change.pairing}`);
  }
  if (change.piece !== undefined) {
    const piece = change.piece;
    if (!piece || typeof piece !== 'object' || typeof piece.id !== 'string') throw new SettingsRefused('invalid', 'piece needs an id and its text');
    await service.handle('save-piece', { id: piece.id, text: piece.text ?? '' });
    applied.push(`piece:${piece.id}`);
  }
  if (change.personaReview === true) { await service.handle('review-persona', {}); applied.push('personaReview'); }
  if (!applied.length) throw new SettingsRefused('invalid', 'Nothing to change');
  return applied;
}

/**
 * The tool's one entry. `request` = { action: 'show' | 'change', piece?: id (show one piece's text),
 * change?: { companion?, telegram?, pairing?, piece?, personaReview? } }.
 * `sessionId` is the calling conversation, which must be the companion's.
 */
export async function companionSettings({ sessionId, sessionsDir, request = {}, env = process.env, service, origin } = {}) {
  const companionId = readState(env).sessionId;
  if (!sessionId || sessionId !== companionId) throw new SettingsRefused('not-companion', "Only Segno's own conversation has settings to change");
  const action = request.action ?? 'show';
  if (!SETTINGS_ACTIONS.includes(action)) throw new SettingsRefused('invalid', `action is one of ${SETTINGS_ACTIONS.join(', ')}`);
  const settings = service ?? await defaultService(env);
  const from = origin ?? await currentOrigin({ sessionsDir, sessionId });
  const byUser = isUserOrigin(from);
  if (action === 'show') {
    if (typeof request.piece === 'string') return { piece: await pieceText(settings, request.piece) };
    return { settings: await settingsView(settings, { showPairingCode: byUser }) };
  }
  if (!byUser) {
    throw new SettingsRefused('not-the-user',
      'Only the user changes settings: this turn was not opened by their message in the app or their Telegram chat');
  }
  try {
    const applied = await applyChange(settings, request.change);
    return { applied, settings: await settingsView(settings, { showPairingCode: true }) };
  } catch (error) {
    if (error instanceof SettingsRefused) throw error;
    // The page's own validation answers with its message (CompanionRequestError 400 'invalid').
    if (error?.code === 'invalid') throw new SettingsRefused('invalid', error.message);
    throw error;
  }
}
