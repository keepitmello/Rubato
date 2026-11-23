// Adding, shaping and picturing a companion from the app (intent companion-manage): the app makes a
// home and registers it, the new companion's first meeting fills its profile, the companion proposes
// rewrites of its own pieces that only the person's "apply" saves, and either device sets its picture.
//
//   create        home under the registry's folder (registry appHomesDir), seeded from the nameless
//                 new-companion pieces (harness/prompts/companion/new), registered with madeInApp
//   onboarding    profile.json facts set one by one in the conversation; finish settles the name
//                 into the registry and leaves what waits in the resident memory
//   proposals     appDataDir/proposals/<id>.json: an excerpt of one piece and its rewrite, or a picture;
//                 nothing is written to a piece until applyProposal, and a declined one writes nothing
//   picture       companion.mjs appDataDir: outside every home, so a companion's records stay untouched
//
// Everything here takes a companion's scoped environment (registry companionEnv), like companion.mjs.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CARD_KEYS, CARD_LIMIT, FACT_LIMIT, ONBOARDING_CORE, ONBOARDING_ITEMS, PICTURE_TYPES, PIECES, PIECE_LIMIT,
  companionPaths, memoryPiecePath, onboardingActive, personalPiecePath, pictureDir, pictureFile, readPieces, readProfile,
  seedPromptPieces, writePiece, writeProfile, writeSettings } from './companion.mjs';
import { appHomesDir, companionEnv, newCompanionId, registerCompanion, retitleCompanion } from './registry.mjs';

export class ManageError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'ManageError'; this.code = code; this.status = status; }
}

/** The registry title of a companion that has no name yet; the apps show their own words for it. */
export const UNNAMED_TITLE = 'New companion';

/**
 * Makes a new companion: its home, its own copy of the nameless pieces, an open first meeting and
 * the switch on, then its registry entry. The engine picks the entry up and opens its conversation.
 * A home that could not be registered is removed again, so a failed create leaves nothing behind.
 */
export function createCompanion({ env = process.env, defaultsDir, now = Date.now, id = newCompanionId(env) } = {}) {
  if (!defaultsDir) throw new TypeError('creating a companion needs the folder the default pieces live in');
  const home = path.join(appHomesDir(env), id);
  if (existsSync(home)) throw new ManageError('exists', 'A folder for that companion already exists', 409);
  const entry = { id, title: UNNAMED_TITLE, home, memoryAgent: id, madeInApp: true, createdAt: new Date(now()).toISOString() };
  // The scoped environment the registry would give it, before the entry exists.
  const scoped = { ...env, RUBATO_COMPANION_ID: id, RUBATO_COMPANION_HOME: home, RUBATO_COMPANION_MADE_IN_APP: '1',
    RUBATO_COMPANION_PROMPT_FILES: '{}', RUBATO_COMPANION_LAYOUT: '{}' };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    seedPromptPieces({ defaultsDir, env: scoped });
    writeProfile({ facts: {}, deferred: [], onboarding: { startedAt: entry.createdAt } }, scoped);
    writeSettings({ enabled: true }, scoped);
    registerCompanion(entry, env);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return { id, home, env: companionEnv(id, env) };
}

/** The first meeting's chips: each item set, open or put off for later; null once it is over (or never was). */
export function onboardingView(profile) {
  if (!onboardingActive(profile)) return null;
  return { items: ONBOARDING_ITEMS.map((key) => profile.facts[key] ? { key, state: 'set', value: profile.facts[key] }
    : { key, state: profile.deferred.includes(key) ? 'deferred' : 'open' }) };
}

/** What the person reads under a companion's name: how it calls them, and since when it is with them. */
export function profileView(profile, { createdAt, home } = {}) {
  let since = typeof createdAt === 'string' ? createdAt : null;
  if (!since && home) try { since = statSync(home).birthtime.toISOString(); } catch { since = null; }
  return { callsUser: profile.facts.callsUser ?? null, since };
}

const DEFERRED_LABEL = Object.freeze({ look: '내 모습', speech: '내 말투', closeness: '우리가 얼마나 가까운지',
  name: '내 이름', callsUser: '사용자를 부르는 말', work: '사용자가 하는 일', relationship: '우리 사이' });

/**
 * One change to the first meeting: `set` facts as the person said them, `defer` items for later,
 * `finish` when the four core items are set. Finishing settles the name into the registry and
 * writes what waits into the resident memory, so living fills it in later. `retitle` renames the
 * conversation (session link).
 */
export function changeOnboarding(change, { env = process.env, defaultsDir, now = Date.now } = {}) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new ManageError('invalid', 'onboarding needs { set?, defer?, finish? }');
  const unknown = Object.keys(change).filter((key) => !['set', 'defer', 'finish'].includes(key));
  if (unknown.length) throw new ManageError('invalid', `Not part of the first meeting: ${unknown.join(', ')}`);
  const profile = readProfile(env);
  if (!profile.onboarding) throw new ManageError('invalid', 'Only a companion made in the app has a first meeting');
  const facts = { ...profile.facts };
  let deferred = [...profile.deferred];
  if (change.set !== undefined) {
    if (!change.set || typeof change.set !== 'object' || Array.isArray(change.set)) throw new ManageError('invalid', 'set is { key: value }');
    for (const [key, value] of Object.entries(change.set)) {
      if (!ONBOARDING_ITEMS.includes(key)) throw new ManageError('invalid', `set takes ${ONBOARDING_ITEMS.join(', ')}`);
      if (typeof value !== 'string' || !value.trim() || value.trim().length > FACT_LIMIT)
        throw new ManageError('invalid', `${key} is 1 to ${FACT_LIMIT} characters`);
      facts[key] = value.trim();
      deferred = deferred.filter((item) => item !== key);
    }
  }
  if (change.defer !== undefined) {
    if (!Array.isArray(change.defer) || change.defer.some((key) => !ONBOARDING_ITEMS.includes(key)))
      throw new ManageError('invalid', `defer lists keys of ${ONBOARDING_ITEMS.join(', ')}`);
    const core = change.defer.filter((key) => ONBOARDING_CORE.includes(key));
    if (core.length) throw new ManageError('invalid', `${core.join(', ')} cannot wait: the first meeting settles it`);
    deferred = [...new Set([...deferred, ...change.defer.filter((key) => !facts[key])])];
  }
  if (change.finish !== undefined && change.finish !== true) throw new ManageError('invalid', 'finish is true');
  const finishing = change.finish === true && !profile.onboarding.finishedAt;
  if (finishing) {
    const missing = ONBOARDING_CORE.filter((key) => !facts[key]);
    if (missing.length) throw new ManageError('invalid', `Still to settle before finishing: ${missing.join(', ')}`);
  }
  const onboarding = finishing ? { ...profile.onboarding, finishedAt: new Date(now()).toISOString() } : profile.onboarding;
  const next = writeProfile({ ...profile, facts, deferred, onboarding }, env);
  let title;
  const nameChanged = facts.name && facts.name !== profile.facts.name;
  if (finishing || (nameChanged && onboarding.finishedAt)) title = retitleCompanion(env.RUBATO_COMPANION_ID, facts.name, env).title;
  if (finishing) leaveDeferredInMemory(next.deferred.concat(ONBOARDING_ITEMS.filter((key) => !facts[key] && !next.deferred.includes(key))), { env, defaultsDir });
  return { profile: next, onboarding: onboardingView(next), finished: finishing, ...(title ? { title } : {}) };
}

/** The first meeting's open ends, as one short section of the resident memory the dream keeps from then on. */
function leaveDeferredInMemory(keys, { env, defaultsDir }) {
  if (!keys.length) return;
  const file = memoryPiecePath(env);
  let text;
  try { text = readFileSync(file, 'utf8').trimEnd(); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    text = defaultsDir ? readFileSync(path.join(defaultsDir, 'memory.pi.md'), 'utf8').trimEnd() : '';
  }
  const lines = keys.map((key) => `- ${DEFERRED_LABEL[key]}: 첫 만남에서 미뤘어. 살면서 사용자랑 같이 정해.`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${text}\n\n## 나중에 같이 정하기로 한 것\n\n${lines.join('\n')}\n`, { mode: 0o600 });
}

/** The two readable cards, written by the companion itself; each row a short line in the person's language. */
export function writeCards(cards, { env = process.env, now = Date.now } = {}) {
  if (!cards || typeof cards !== 'object' || Array.isArray(cards)) throw new ManageError('invalid', 'summary is { who?, me? }');
  const unknown = Object.keys(cards).filter((key) => !(key in CARD_KEYS));
  if (unknown.length) throw new ManageError('invalid', `summary takes who and me, not ${unknown.join(', ')}`);
  const profile = readProfile(env);
  const next = { ...(profile.cards ?? {}) };
  for (const [card, rows] of Object.entries(cards)) {
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new ManageError('invalid', `${card} is { ${CARD_KEYS[card].join(', ')} }`);
    const bad = Object.keys(rows).filter((key) => !CARD_KEYS[card].includes(key));
    if (bad.length) throw new ManageError('invalid', `${card} takes ${CARD_KEYS[card].join(', ')}`);
    for (const [key, value] of Object.entries(rows))
      if (typeof value !== 'string' || value.trim().length > CARD_LIMIT) throw new ManageError('invalid', `${card}.${key} is text of at most ${CARD_LIMIT} characters`);
    next[card] = Object.fromEntries(Object.entries({ ...next[card], ...rows }).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));
  }
  next.updatedAt = new Date(now()).toISOString();
  return writeProfile({ ...profile, cards: next }, env).cards;
}

/** The cards as the apps draw them: rows in their fixed order, null for a card not written yet. */
export function cardsView(profile) {
  const card = (name) => {
    const rows = CARD_KEYS[name].filter((key) => profile.cards?.[name]?.[key]).map((key) => ({ key, text: profile.cards[name][key] }));
    return rows.length ? { rows } : null;
  };
  return { who: card('who'), me: card('me'), updatedAt: profile.cards?.updatedAt ?? null };
}

// ---- pictures -------------------------------------------------------------------------------

export const PICTURE_LIMIT = 2 * 1024 * 1024;
/** A picture the companion drew may be larger than an upload from a phone; it is kept as drawn. */
export const DRAWN_PICTURE_LIMIT = 12 * 1024 * 1024;

/** The image type the bytes really are, or undefined. */
export function sniffImage(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

function storePicture(bytes, env, slot = 'avatar') {
  const mime = sniffImage(bytes);
  if (!mime) throw new ManageError('invalid', 'The picture must be a JPEG, PNG or WebP image');
  const dir = pictureDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${slot}.${PICTURE_TYPES[mime]}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, file);
  for (const ext of Object.values(PICTURE_TYPES)) if (ext !== PICTURE_TYPES[mime]) rmSync(path.join(dir, `${slot}.${ext}`), { force: true });
  return file;
}

/** Sets (or with null clears) the picture from an uploaded data URL. Only the picture folder is written. */
export function setPicture(image, { env = process.env, slot = 'avatar' } = {}) {
  if (slot !== 'avatar' && slot !== 'icon') throw new ManageError('invalid', 'Unknown picture slot');
  if (image === null) {
    for (const ext of Object.values(PICTURE_TYPES)) rmSync(path.join(pictureDir(env), `${slot}.${ext}`), { force: true });
    return null;
  }
  const match = typeof image === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(image);
  if (!match) throw new ManageError('invalid', 'image is a data URL of a JPEG, PNG or WebP picture, or null');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > PICTURE_LIMIT) throw new ManageError('too-large', `A picture holds at most ${PICTURE_LIMIT / 1024 / 1024} MB`, 413);
  return storePicture(bytes, env, slot);
}

// ---- proposals ------------------------------------------------------------------------------

const LABEL_LIMIT = 120;
const KEEP_PROPOSALS = 50;
const STATUSES = new Set(['open', 'applied', 'declined', 'superseded', 'stale']);

const proposalFile = (env, id) => path.join(companionPaths(env).proposals, `${id}.json`);
const occurrences = (text, part) => (part ? text.split(part).length - 1 : 0);

function readProposal(env, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new ManageError('invalid', 'proposalId is missing');
  try { return JSON.parse(readFileSync(proposalFile(env, id), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') throw new ManageError('not-found', 'No such proposal', 404); throw error; }
}

function saveProposal(env, proposal) {
  const file = proposalFile(env, proposal.id);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(proposal, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return proposal;
}

/** Every proposal, oldest first; beyond the newest fifty, closed ones are dropped. */
export function listProposals({ env = process.env } = {}) {
  const dir = companionPaths(env).proposals;
  let names;
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const all = names.flatMap((name) => { try { return [JSON.parse(readFileSync(path.join(dir, name), 'utf8'))]; } catch { return []; } })
    .filter((item) => STATUSES.has(item?.status)).sort((a, b) => a.createdAt - b.createdAt);
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_PROPOSALS)).filter((item) => item.status !== 'open')) {
    rmSync(proposalFile(env, old.id), { force: true });
    if (old.image) rmSync(path.join(dir, old.image), { force: true });
  }
  return all.slice(-KEEP_PROPOSALS);
}

/** A proposal as the apps draw it: a picture as a data URL instead of its file name. */
export function proposalView(proposal, { env = process.env } = {}) {
  const { image, ...rest } = proposal;
  if (!image) return rest;
  try {
    const bytes = readFileSync(path.join(companionPaths(env).proposals, image));
    return { ...rest, image: { url: `data:${sniffImage(bytes)};base64,${bytes.toString('base64')}` } };
  } catch { return { ...rest, image: null }; }
}

/** The text a piece has now: the person's own version, else the default it follows. */
function currentPieceText(id, { env, defaultsDir }) {
  const piece = readPieces({ defaultsDir, env }).find((item) => item.id === id);
  if (!piece) throw new ManageError('invalid', `No prompt piece is called ${id}`);
  if (!piece.editable) throw new ManageError('invalid', `The ${id} piece follows Rubato and has no personal version`);
  return piece.personalText ?? piece.defaultText;
}

/**
 * The companion's rewrite of part of one of its own pieces, or a picture it drew for itself,
 * waiting for the person: `{ piece, label, before, after }` with `before` an excerpt found exactly
 * once in the piece now, or `{ image: <absolute file>, label }`. A newer proposal for the same piece
 * (or a newer picture) replaces an open one. Nothing else is written.
 */
export function propose(request, { env = process.env, defaultsDir, now = Date.now } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new ManageError('invalid', 'proposal needs { piece, label, before, after } or { image, label }');
  const label = typeof request.label === 'string' ? request.label.trim() : '';
  if (!label || label.length > LABEL_LIMIT) throw new ManageError('invalid', `label is 1 to ${LABEL_LIMIT} characters, in the user's words`);
  const id = randomUUID();
  let proposal;
  if (request.image !== undefined) {
    if (typeof request.image !== 'string' || !path.isAbsolute(request.image)) throw new ManageError('invalid', 'image is the absolute path of the picture file');
    let bytes;
    try { bytes = readFileSync(request.image); } catch { throw new ManageError('invalid', 'The picture file cannot be read'); }
    const kind = request.target ?? 'avatar';
    if (kind !== 'avatar' && kind !== 'icon') throw new ManageError('invalid', 'Image target must be avatar or icon');
    if (bytes.length > (kind === 'icon' ? PICTURE_LIMIT : DRAWN_PICTURE_LIMIT)) throw new ManageError('too-large', 'The picture is too large');
    const mime = sniffImage(bytes);
    if (!mime) throw new ManageError('invalid', 'The picture must be a JPEG, PNG or WebP image');
    const name = `${id}.${PICTURE_TYPES[mime]}`;
    mkdirSync(companionPaths(env).proposals, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(companionPaths(env).proposals, name), bytes, { mode: 0o600 });
    proposal = { id, kind, createdAt: now(), status: 'open', label, image: name };
  } else {
    const { piece, before, after } = request;
    if (typeof piece !== 'string' || !PIECES.some((item) => item.id === piece)) throw new ManageError('invalid', `piece is one of ${PIECES.map((item) => item.id).join(', ')}`);
    if (typeof before !== 'string' || !before.trim()) throw new ManageError('invalid', 'before is the exact excerpt of the piece being rewritten');
    if (typeof after !== 'string') throw new ManageError('invalid', 'after is the rewritten excerpt');
    const text = currentPieceText(piece, { env, defaultsDir });
    const found = occurrences(text, before);
    if (found !== 1) throw new ManageError('invalid', found === 0
      ? 'before is not in the piece as it is now: read it with show and copy the excerpt exactly'
      : 'before appears more than once: take a longer excerpt so it is found exactly once');
    if (text.length - before.length + after.length > PIECE_LIMIT) throw new ManageError('invalid', `A piece holds at most ${PIECE_LIMIT} characters`);
    if (before === after) throw new ManageError('invalid', 'after is the same as before');
    proposal = { id, kind: 'piece', createdAt: now(), status: 'open', label, piece, before, after };
  }
  for (const open of listProposals({ env }).filter((item) => item.status === 'open' && item.kind === proposal.kind
    && (proposal.kind !== 'piece' || item.piece === proposal.piece)))
    saveProposal(env, { ...open, status: 'superseded', closedAt: now() });
  return saveProposal(env, proposal);
}

/**
 * The person's apply: the one write a proposal leads to. A piece rewrite lands only while its excerpt
 * is still in the piece exactly once; otherwise the proposal goes stale and nothing is written.
 */
export function applyProposal(id, { env = process.env, defaultsDir, now = Date.now } = {}) {
  const proposal = readProposal(env, id);
  if (proposal.status !== 'open') throw new ManageError('closed', `This proposal is ${proposal.status}`, 409);
  if (proposal.kind === 'avatar' || proposal.kind === 'icon') {
    const bytes = readFileSync(path.join(companionPaths(env).proposals, proposal.image));
    storePicture(bytes, env, proposal.kind);
  } else {
    const text = currentPieceText(proposal.piece, { env, defaultsDir });
    if (occurrences(text, proposal.before) !== 1) {
      saveProposal(env, { ...proposal, status: 'stale', closedAt: now() });
      throw new ManageError('stale', 'The piece changed since this was proposed; ask for it again', 409);
    }
    const at = text.indexOf(proposal.before);
    writePiece(proposal.piece, text.slice(0, at) + proposal.after + text.slice(at + proposal.before.length), { defaultsDir, env });
  }
  return saveProposal(env, { ...proposal, status: 'applied', closedAt: now() });
}

/** The person passes on it: only the proposal's own record changes. */
export function declineProposal(id, { env = process.env, now = Date.now } = {}) {
  const proposal = readProposal(env, id);
  if (proposal.status !== 'open') throw new ManageError('closed', `This proposal is ${proposal.status}`, 409);
  return saveProposal(env, { ...proposal, status: 'declined', closedAt: now() });
}

