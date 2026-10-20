// What arrives with a Telegram message besides words, ported from Roo's daemon
// (~/.claude/roo-channel/plugins/telegram-daemon/daemon.ts message:photo … message:sticker,
// telegram-stt.ts): a photo is saved and shown to Segno as an image, a file is saved where Segno
// can open it, and a voice message is transcribed into words tagged `[voice]`.
//
// Roo leaves documents for its `download_attachment` tool; here every file the Bot API will hand
// over (up to 20 MB) is saved on arrival, so Segno never needs a tool for it.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOWNLOAD_LIMIT_BYTES, redactToken } from './bot-api.mjs';
import { messengerPaths } from './store.mjs';

export const VOICE_TAG = '[voice]';
export const VOICE_FAILURE_TAG = '[voice:전사 실패]';

const safeSegment = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown';
const safeName = (value) => (typeof value === 'string' && value.trim() ? value.trim().replace(/[\\/\0]/g, '_').slice(0, 120) : undefined);
const extOf = (filePath, fallback) => {
  const ext = path.extname(filePath ?? '').replace(/^\./, '').toLowerCase();
  if (ext === 'oga') return 'ogg';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
};

/**
 * The one attachment a message carries, as Roo's daemon reads it, with the words Roo puts in its
 * place when there is no caption.
 */
export function mediaOf(message) {
  const caption = typeof message.caption === 'string' && message.caption.trim() ? message.caption : undefined;
  if (Array.isArray(message.photo) && message.photo.length) {
    const best = message.photo.at(-1);
    return { kind: 'photo', fileId: best.file_id, uniqueId: best.file_unique_id, size: best.file_size, mime: 'image/jpeg', text: caption ?? '(photo)' };
  }
  if (message.document) {
    const doc = message.document;
    const name = safeName(doc.file_name);
    return { kind: 'document', fileId: doc.file_id, uniqueId: doc.file_unique_id, size: doc.file_size, mime: doc.mime_type, name,
      text: caption ?? `(document: ${name ?? 'file'})` };
  }
  if (message.voice) {
    const voice = message.voice;
    return { kind: 'voice', fileId: voice.file_id, uniqueId: voice.file_unique_id, size: voice.file_size, mime: voice.mime_type, text: '(voice message)' };
  }
  if (message.audio) {
    const audio = message.audio;
    return { kind: 'audio', fileId: audio.file_id, uniqueId: audio.file_unique_id, size: audio.file_size, mime: audio.mime_type,
      name: safeName(audio.file_name), text: '(audio message)' };
  }
  if (message.video) {
    const video = message.video;
    return { kind: 'video', fileId: video.file_id, uniqueId: video.file_unique_id, size: video.file_size, mime: video.mime_type,
      name: safeName(video.file_name), text: caption ?? '(video)' };
  }
  if (message.video_note) {
    const note = message.video_note;
    return { kind: 'video_note', fileId: note.file_id, uniqueId: note.file_unique_id, size: note.file_size, text: '(video note)' };
  }
  if (message.animation) {
    const animation = message.animation;
    return { kind: 'animation', fileId: animation.file_id, uniqueId: animation.file_unique_id, size: animation.file_size,
      mime: animation.mime_type, name: safeName(animation.file_name), text: caption ?? '(animation)' };
  }
  if (message.sticker) {
    const sticker = message.sticker;
    return { kind: 'sticker', fileId: sticker.file_id, uniqueId: sticker.file_unique_id, size: sticker.file_size,
      text: `(sticker${sticker.emoji ? ` ${sticker.emoji}` : ''})` };
  }
  return undefined;
}

/** The bytes of one Telegram file, and the path Telegram gave it. Refused above the Bot API's limit. */
export async function downloadMedia(client, media) {
  if (Number.isFinite(media.size) && media.size > DOWNLOAD_LIMIT_BYTES) throw new Error(`too large for a bot to download (${media.size} bytes)`);
  const file = await client.getFile({ fileId: media.fileId });
  if (!file?.file_path) throw new Error('Telegram returned no file path; the file may have expired');
  const bytes = await client.downloadFile({ filePath: file.file_path });
  if (!bytes?.length) throw new Error('Telegram returned an empty file');
  return { bytes, filePath: file.file_path };
}

/** A received file saved under the companion's home: `<received>/<time>-<id>.<ext>`. */
export async function saveMedia(client, media, { env, now = Date.now } = {}) {
  const { bytes, filePath } = await downloadMedia(client, media);
  const dir = messengerPaths(env).received;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = safeSegment(media.uniqueId ?? createHash('sha256').update(media.fileId).digest('hex').slice(0, 16));
  const ext = extOf(media.name ?? filePath, extOf(filePath, media.kind === 'photo' ? 'jpg' : 'bin'));
  const file = path.join(dir, `${now()}-${id}.${ext}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { kind: media.kind, path: file, ...(media.mime ? { mime: media.mime } : {}), ...(media.name ? { name: media.name } : {}),
    size: bytes.length };
}

function writeRecord(file, record) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * A voice or audio message as words (Roo's transcribeTelegramAttachment): the audio and what it
 * said stay in `<stt>/<time>-<id>/`, and the conversation gets `[voice]` and the transcript, or
 * the failure tag when it could not be heard. Never throws.
 */
export async function transcribeMedia(client, media, { env, transcribe, receivedAt, chatId, messageId, reportError = () => {} }) {
  const stamp = String(receivedAt ?? new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 17);
  const dir = path.join(messengerPaths(env).stt, `${stamp}-${safeSegment(media.uniqueId ?? `${chatId}-${messageId}`)}`);
  const base = { version: 1, receivedAt, kind: media.kind,
    telegram: { fileId: media.fileId, ...(media.uniqueId ? { fileUniqueId: media.uniqueId } : {}),
      ...(messageId === undefined ? {} : { messageId }), ...(chatId ? { chatId: String(chatId) } : {}) } };
  let archived = true;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (error) { archived = false; reportError(error); }
  let audioFile = null;
  const record = (value) => { if (archived) try { writeRecord(path.join(dir, 'transcription.json'), { ...base, ...value }); } catch (error) { reportError(error); } };
  try {
    if (typeof transcribe !== 'function') throw new Error('voice transcription is not set up');
    const { bytes, filePath } = await downloadMedia(client, media);
    const ext = extOf(media.name ?? filePath, media.mime === 'audio/mpeg' ? 'mp3' : media.mime === 'audio/mp4' ? 'm4a' : 'ogg');
    const audioPath = path.join(dir, `audio.${ext}`);
    writeFileSync(audioPath, bytes, { mode: 0o600 });
    audioFile = path.basename(audioPath);
    const result = await transcribe({ path: audioPath, bytes, ext, mime: media.mime });
    const transcript = String(result?.text ?? '').trim();
    if (!transcript) throw new Error('the transcription came back empty');
    record({ status: 'transcribed', audioFile, transcript, engine: result.engine ?? null, error: null });
    return { status: 'transcribed', text: `${VOICE_TAG}\n${transcript}`, archive: dir };
  } catch (error) {
    const reason = redactToken(error?.message ?? error).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300);
    record({ status: 'failed', audioFile, transcript: null, engine: null, error: reason });
    return { status: 'failed', text: `${VOICE_FAILURE_TAG}\n음성 내용을 전사하지 못했어.`, archive: dir, error: reason };
  }
}
