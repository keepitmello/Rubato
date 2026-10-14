// Settings > General > Behavior, server half: the sounds a thread notification
// can play besides T3's two built-in ones. They are this Mac's alert sounds, the
// folders System Settings > Sound reads: macOS's own, then any put in
// /Library/Sounds or ~/Library/Sounds. The client plays them, so the bytes go
// over HTTP. Chromium does not decode AIFF or CAF; those go through afconvert to
// WAV once and stay in a cache keyed by the file's path, mtime and size.
//
//   POST list          { sounds: [{ id, name, folder }] }
//   POST file { id }   the audio bytes
//
// An id is "mac:<folder>/<file name>" and names only a file the listing of that
// folder returns, so a request reaches nothing else on disk.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FOLDER_ORDER = ['system', 'local', 'user'];
const AUDIO_FILE = /\.(aiff?|caf|wav|mp3|m4a|aac|flac|ogg)$/i;
// What Chromium decodes as is; the rest goes through afconvert.
const PLAYABLE_FILE = /\.(wav|mp3|m4a|aac|flac|ogg)$/i;
// A file this large is not an alert sound; refuse it rather than send it.
const MAX_SOUND_BYTES = 20 * 1024 * 1024;

export class SoundsRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isSoundFileName(name) {
  return !name.startsWith('.') && AUDIO_FILE.test(name) && path.basename(name) === name;
}

function contentTypeOf(file) {
  const extension = path.extname(file).slice(1).toLowerCase();
  if (extension === 'mp3') return 'audio/mpeg';
  if (extension === 'm4a' || extension === 'aac') return 'audio/mp4';
  return `audio/${extension}`;
}

/**
 * @param {{ folders?: { system: string, local: string, user: string }, cacheDirectory?: string,
 *   convert?: (input: string, output: string) => Promise<unknown> }} [options]
 */
export function createSoundsService(options = {}) {
  const folders = options.folders ?? {
    system: '/System/Library/Sounds',
    local: '/Library/Sounds',
    user: path.join(homedir(), 'Library', 'Sounds'),
  };
  const cacheDirectory = options.cacheDirectory ?? path.join(tmpdir(), 'rubato-sounds');
  const convert = options.convert
    ?? ((input, output) => run('afconvert', ['-f', 'WAVE', '-d', 'LEI16', input, output], { timeout: 10_000 }));

  /** Every alert sound, system ones first, each folder by name. */
  async function list() {
    const sounds = [];
    for (const folder of FOLDER_ORDER) {
      const entries = await readdir(folders[folder], { withFileTypes: true }).catch(() => []);
      const names = entries
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isSoundFileName(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
      for (const name of names)
        sounds.push({ id: `mac:${folder}/${name}`, name: name.replace(AUDIO_FILE, ''), folder });
    }
    return sounds;
  }

  /** The file an id names, or null when the id is not one the listing returns. */
  async function resolve(id) {
    if (typeof id !== 'string') return null;
    const match = /^mac:(system|local|user)\/(.+)$/.exec(id);
    if (!match || !isSoundFileName(match[2])) return null;
    if (!(await list()).some((sound) => sound.id === id)) return null;
    const file = path.join(folders[match[1]], match[2]);
    const info = await stat(file).catch(() => null);
    return info?.isFile() ? file : null;
  }

  /** The sound's bytes in a format the browser decodes. */
  async function playable(file) {
    const info = await stat(file);
    if (info.size > MAX_SOUND_BYTES) throw new SoundsRequestError(413, 'too-large', 'That sound file is too large.');
    if (PLAYABLE_FILE.test(file)) return { bytes: await readFile(file), contentType: contentTypeOf(file) };
    const key = createHash('sha256').update(`${file}\0${info.mtimeMs}\0${info.size}`).digest('hex');
    const converted = path.join(cacheDirectory, `${key}.wav`);
    const cached = await readFile(converted).catch(() => null);
    if (cached) return { bytes: cached, contentType: 'audio/wav' };
    await mkdir(cacheDirectory, { recursive: true });
    const temporary = path.join(cacheDirectory, `${key}.${randomUUID()}.tmp.wav`);
    try {
      await convert(file, temporary);
      await rename(temporary, converted);
    } catch (error) {
      throw new SoundsRequestError(500, 'convert-failed',
        `Could not convert the sound: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { bytes: await readFile(converted), contentType: 'audio/wav' };
  }

  async function file(id) {
    const found = await resolve(id);
    if (found === null) throw new SoundsRequestError(404, 'unknown-sound', 'That sound is not on this Mac.');
    return playable(found);
  }

  return { list, resolve, file };
}

export async function handleSoundsRequest(service, request) {
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (request.method !== 'POST')
    return Response.json({ error: { code: 'method', message: 'Use POST.' } }, { status: 405 });
  try {
    if (action === 'list') return Response.json({ sounds: await service.list() });
    if (action === 'file') {
      const body = await request.json().catch(() => null);
      const { bytes, contentType } = await service.file(body?.id);
      return new Response(bytes, { headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
    }
    return Response.json({ error: { code: 'not-found', message: `Unknown sounds action: ${action}` } }, { status: 404 });
  } catch (error) {
    const status = error instanceof SoundsRequestError ? error.status : 500;
    const code = error instanceof SoundsRequestError ? error.code : 'failed';
    return Response.json({ error: { code, message: error instanceof Error ? error.message : String(error) } }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function soundsService() {
  shared ??= createSoundsService();
  return shared;
}
