// Advanced, local registration. The built-in companion keeps its historical home and identity.
// Private names, paths and extension settings belong in the user's registry, never this bundle.
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_COMPANION_ID = 'segno';
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const PRIVATE_ENV = /^RUBATO_COMPANION_|^ROO_|^MSEARCH_/;

/**
 * Whether this companion lives on Rubato's own texts: Segno, and every companion the app made
 * (registry `madeInApp`). Those read the product's work rules, tools, wake, recall, greetings and
 * dream; a hand-registered existing home reads only the texts it mapped and never borrows these.
 */
export function usesProductTexts(env = process.env) {
  return !env.RUBATO_COMPANION_ID || env.RUBATO_COMPANION_ID === DEFAULT_COMPANION_ID || env.RUBATO_COMPANION_MADE_IN_APP === '1';
}
function canonicalHome(home) {
  try { return realpathSync(home); }
  catch {
    const parent = path.dirname(home);
    return parent === home ? home : path.join(canonicalHome(parent), path.basename(home));
  }
}
function validateCall(call, ports) {
  if (call === undefined) return;
  if (!call || typeof call !== 'object' || typeof call.enabled !== 'boolean')
    throw new TypeError('call needs an explicit enabled setting');
  if (call.enabled) {
    if (!Number.isInteger(call.port) || call.port < 1 || call.port > 65535 || ports.has(call.port))
      throw new TypeError('each enabled call needs a distinct port');
    if (call.host !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(call.host))
      throw new TypeError('call host must be loopback');
    ports.add(call.port);
  }
  for (const key of ['stateDir', 'transcriptDir'])
    if (call[key] !== undefined && (typeof call[key] !== 'string' || path.isAbsolute(call[key]) || call[key].split(/[\\/]/).includes('..')))
      throw new TypeError(`call.${key} must stay in the home`);
}

export function registryPath(env = process.env) {
  return env.RUBATO_COMPANIONS_FILE || path.join(env.HOME || homedir(), '.rubato', 'companions.json');
}

export function listCompanions(env = process.env) {
  const builtin = { id: DEFAULT_COMPANION_ID, title: 'Segno',
    home: path.resolve(env.RUBATO_DEFAULT_COMPANION_HOME || env.RUBATO_COMPANION_HOME || path.join(env.HOME || homedir(), '.rubato', 'companion')),
    memoryAgent: 'segno', telegram: false };
  let data;
  try { data = JSON.parse(readFileSync(registryPath(env), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return [builtin]; throw error; }
  if (!Array.isArray(data?.companions)) throw new TypeError('companions must be a list');
  // Explicit capability opt-in for the built-in companion; registering another one never opts it in.
  if (data.default !== undefined) {
    if (!data.default || typeof data.default !== 'object' || Object.keys(data.default).some(key => !['call', 'telegram'].includes(key)))
      throw new TypeError('default only configures optional call/telegram capabilities');
    if (data.default.telegram !== undefined && typeof data.default.telegram !== 'boolean') throw new TypeError('telegram must be boolean');
    Object.assign(builtin, data.default);
  }
  const seen = new Set([builtin.id]);
  const homes = new Set([canonicalHome(builtin.home)]);
  const agents = new Set([builtin.memoryAgent]);
  const callPorts = new Set();
  validateCall(builtin.call, callPorts);
  return [builtin, ...data.companions.map((value) => {
    if (!ID.test(value?.id) || seen.has(value.id)) throw new TypeError('each additional companion needs a unique id');
    if (typeof value.home !== 'string' || !path.isAbsolute(value.home) || [...homes].some(known => {
      const own = canonicalHome(value.home);
      return own === known || own.startsWith(known + path.sep) || known.startsWith(own + path.sep);
    }))
      throw new TypeError('each companion needs a distinct absolute home');
    if (!ID.test(value.memoryAgent) || agents.has(value.memoryAgent)) throw new TypeError('each companion needs a distinct memory agent');
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120) throw new TypeError('companion title is missing');
    if (value.env && (typeof value.env !== 'object' || Array.isArray(value.env)
      || Object.entries(value.env).some(([key, item]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof item !== 'string')))
      throw new TypeError('companion env must contain string environment settings');
    for (const [key, file] of Object.entries(value.promptFiles ?? {}))
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError(`promptFiles.${key} must be absolute`);
    for (const [key, file] of Object.entries(value.layout ?? {}))
      if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))
        throw new TypeError(`layout.${key} must stay in the home`);
    for (const key of ['historyPaths', 'dreamReadPaths', 'dreamWritePaths', 'searchPaths', 'searchExclude']) {
      if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(file =>
        typeof file !== 'string' || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))))
        throw new TypeError(`${key} must name paths inside the home`);
    }
    if (value.dreamInstructions !== undefined && (typeof value.dreamInstructions !== 'string' || !path.isAbsolute(value.dreamInstructions)))
      throw new TypeError('dreamInstructions must be absolute');
    if (value.skillDirs !== undefined && (!Array.isArray(value.skillDirs) ||
      value.skillDirs.some(dir => typeof dir !== 'string' || !path.isAbsolute(dir)))) throw new TypeError('skillDirs must be absolute');
    if (value.extensions !== undefined && (!Array.isArray(value.extensions) ||
      value.extensions.some(file => typeof file !== 'string' || !path.isAbsolute(file)))) throw new TypeError('extensions must be absolute');
    if (value.madeInApp !== undefined && typeof value.madeInApp !== 'boolean') throw new TypeError('madeInApp must be true or false');
    validateCall(value.call, callPorts);
    seen.add(value.id); homes.add(canonicalHome(value.home)); agents.add(value.memoryAgent);
    return { ...value, home: path.resolve(value.home), title: value.title.trim(), telegram: value.telegram === true };
  })];
}

export function companionProfile(id = DEFAULT_COMPANION_ID, env = process.env) {
  const profile = listCompanions(env).find((item) => item.id === id);
  if (!profile) throw new TypeError(`Unknown companion: ${id}`);
  return profile;
}

/** Never inherit another companion's private environment into a lead or sibling companion. */
export function clearCompanionEnv(env = process.env) {
  const privateKeys = new Set(JSON.parse(env.RUBATO_COMPANION_PRIVATE_ENV_KEYS || '[]'));
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    !privateKeys.has(key) && !PRIVATE_ENV.test(key) && !(key === 'RUBATO_PI_ROLE' && value === 'companion')));
}

export function companionEnv(id = DEFAULT_COMPANION_ID, env = process.env) {
  const profile = companionProfile(id, env);
  return { ...clearCompanionEnv(env), ...profile.env,
    RUBATO_COMPANIONS_FILE: registryPath(env),
    RUBATO_DEFAULT_COMPANION_HOME: listCompanions(env)[0].home,
    RUBATO_COMPANION_ID: profile.id, RUBATO_COMPANION_TITLE: profile.title,
    RUBATO_COMPANION_HOME: profile.home, RUBATO_COMPANION_MEMORY_AGENT: profile.memoryAgent,
    RUBATO_COMPANION_LAYOUT: JSON.stringify(profile.layout ?? {}),
    RUBATO_COMPANION_PROMPT_FILES: JSON.stringify(profile.promptFiles ?? {}),
    RUBATO_COMPANION_SKILL_DIRS: JSON.stringify(profile.skillDirs ?? []),
    RUBATO_COMPANION_EXTENSIONS: JSON.stringify(profile.extensions ?? []),
    RUBATO_COMPANION_PRIVATE_ENV_KEYS: JSON.stringify(Object.keys(profile.env ?? {})),
    RUBATO_COMPANION_CALL: JSON.stringify(profile.call ?? { enabled: false }),
    RUBATO_COMPANION_HISTORY_PATHS: JSON.stringify(profile.historyPaths ?? []),
    RUBATO_COMPANION_DREAM_READ_PATHS: JSON.stringify(profile.dreamReadPaths ?? []),
    RUBATO_COMPANION_DREAM_WRITE_PATHS: JSON.stringify(profile.dreamWritePaths ?? []),
    ...(profile.searchPaths ? { RUBATO_COMPANION_SEARCH_PATHS: JSON.stringify(profile.searchPaths) } : {}),
    ...(profile.searchExclude ? { RUBATO_COMPANION_SEARCH_EXCLUDE: JSON.stringify(profile.searchExclude) } : {}),
    ...(profile.dreamInstructions ? { RUBATO_COMPANION_DREAM_INSTRUCTIONS: profile.dreamInstructions } : {}),
    RUBATO_COMPANION_TELEGRAM: profile.telegram ? '1' : '0',
    RUBATO_COMPANION_AUTO_RECALL: '0',
    ...(profile.madeInApp ? { RUBATO_COMPANION_MADE_IN_APP: '1' } : {}),
    // A home the app made is Rubato's own layout, like Segno's; a registered existing home keeps its own instructions out.
    RUBATO_COMPANION_RECORDS_ONLY: profile.id === DEFAULT_COMPANION_ID || profile.madeInApp ? '0' : '1' };
}

export function companionServiceName(kind, id = DEFAULT_COMPANION_ID) {
  return id === DEFAULT_COMPANION_ID ? kind : `${kind}:${id}`;
}

// The app writes the registry instead of the person (intent companion-manage). Every write is a
// whole-file replace under a short lock, and the result must pass listCompanions before it lands,
// so a write never leaves a registry the engine would refuse.
const LOCK_STALE_MS = 10_000;

function withRegistryLock(env, work) {
  const file = registryPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { closeSync(openSync(lock, 'wx', 0o600)); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue; } }
      catch { continue; }
      if (Date.now() > deadline) throw new Error('The companion registry is busy; try again');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return work(file); } finally { rmSync(lock, { force: true }); }
}

function readRegistryFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { companions: [] }; throw error; }
}

function writeRegistryFile(file, data, env) {
  // Refuse anything the engine itself would refuse to load.
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { listCompanions({ ...env, RUBATO_COMPANIONS_FILE: temporary }); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  renameSync(temporary, file);
}

/** Where the app puts the homes it makes: beside the registry, one folder per companion. */
export function appHomesDir(env = process.env) {
  return path.join(path.dirname(registryPath(env)), 'companions');
}

/** A fresh id nobody used: never a reused one, so an old memory store or picture cannot attach to a new companion. */
export function newCompanionId(env = process.env, random = () => randomBytes(4).toString('hex')) {
  const taken = new Set(listCompanions(env).map((profile) => profile.id));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `companion-${random()}`;
    if (!taken.has(id) && ID.test(id)) return id;
  }
  throw new Error('Could not pick a new companion id');
}

/** Adds one app-made companion to the registry; existing entries and fields stay as they were. */
export function registerCompanion(entry, env = process.env) {
  return withRegistryLock(env, (file) => {
    const data = readRegistryFile(file);
    if (!Array.isArray(data.companions)) throw new TypeError('companions must be a list');
    data.companions.push(entry);
    writeRegistryFile(file, data, env);
    return companionProfile(entry.id, env);
  });
}

/** Renames an app-made companion (its onboarding gave it a name). Hand-registered entries are the person's. */
export function retitleCompanion(id, title, env = process.env) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw new TypeError('a name is 1 to 120 characters');
  return withRegistryLock(env, (file) => {
    const data = readRegistryFile(file);
    const entry = (data.companions ?? []).find((item) => item?.id === id);
    if (!entry) throw new TypeError(`Unknown companion: ${id}`);
    if (entry.madeInApp !== true) throw new TypeError('Only a companion the app made is renamed here');
    entry.title = title.trim();
    writeRegistryFile(file, data, env);
    return companionProfile(id, env);
  });
}
