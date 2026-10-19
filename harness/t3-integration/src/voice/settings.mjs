// 맥 음성 입력 설정(~/.rubato/voice.json)을 읽고 쓴다. 설정 화면(설정 › 채팅 › 음성 입력)과
// voice-setup.mjs 가 같은 파일을 같은 규칙으로 다룬다.
//
// 런타임은 요청마다 이 파일을 다시 본다(바뀐 경우에만 읽는다). 그래서 저장하면 앱을
// 다시 켜지 않아도 다음 녹음부터 바뀐 키와 모델을 쓴다.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 설정에 모델이 없을 때 쓰는 파일 전사 모델. 근거와 세대 차이는 transcribe.mjs 에 있다. */
export const DEFAULT_VOICE_MODEL = 'gpt-transcribe';

export function voiceConfigPath(env = process.env) {
  return env.RUBATO_VOICE_CONFIG
    ?? path.join(env.HOME ?? env.USERPROFILE ?? homedir(), '.rubato', 'voice.json');
}

export class VoiceSettingsError extends Error {
  constructor(code, message, field = undefined, status = 400) {
    super(message);
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

function readRaw(configPath) {
  let text;
  try { text = readFileSync(configPath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { config: null, error: null };
    return { config: null, error: 'unreadable' };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { config: null, error: 'invalid' };
    return { config: parsed, error: null };
  } catch {
    return { config: null, error: 'invalid' };
  }
}

/** 파일이 바뀐 경우에만 다시 읽는 읽기 함수. 반환값은 `{ config, error }` 다. */
export function createVoiceConfigReader(configPath) {
  let stamp = null;
  let last = { config: null, error: null };
  return () => {
    let stat;
    try { stat = statSync(configPath); }
    catch (error) {
      stamp = null;
      last = { config: null, error: error?.code === 'ENOENT' ? null : 'unreadable' };
      return last;
    }
    const next = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (next !== stamp) {
      last = readRaw(configPath);
      stamp = next;
    }
    return last;
  };
}

/** 세션을 열 수 있는 설정인가. 키는 환경변수로도 올 수 있어 여기서 보지 않는다. */
export function voiceConfigUsable(config) {
  return typeof config?.token === 'string' && config.token.length >= 32
    && typeof config.model === 'string' && config.model.trim() !== '';
}

export function voiceApiKey(config, env = process.env) {
  if (typeof config?.openaiApiKey === 'string' && config.openaiApiKey.trim() !== '') return config.openaiApiKey;
  return env.OPENAI_API_KEY || null;
}

/** 키는 앞 3자와 끝 4자만 남긴다. 화면과 로그에 키 전체가 나가지 않게. */
export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret === '') return null;
  if (secret.length <= 12) return '…';
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

export const newVoiceToken = () => randomBytes(32).toString('base64url');

function writeAtomic(configPath, config) {
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, configPath);
}

/**
 * 바꿀 것만 받아 합쳐 쓴다. `openaiApiKey: null` 은 저장한 키를 지운다(환경변수로
 * 돌아간다). 토큰이 없으면 만들고, 모델이 없으면 기본 모델을 넣는다.
 */
export function updateVoiceConfig(configPath, { model, openaiApiKey, defaultProjectId, rotateToken = false } = {}) {
  const { config: existing, error } = readRaw(configPath);
  if (error) throw new VoiceSettingsError('config-unreadable', `${configPath} could not be read as JSON. Fix or remove it first.`, undefined, 409);
  const next = { ...(existing ?? {}) };
  if (model !== undefined) {
    if (typeof model !== 'string' || model.trim() === '' || /\s/.test(model.trim())) {
      throw new VoiceSettingsError('invalid-model', 'Enter a model id without spaces.', 'model');
    }
    next.model = model.trim();
  }
  if (openaiApiKey === null) delete next.openaiApiKey;
  else if (openaiApiKey !== undefined) {
    const key = typeof openaiApiKey === 'string' ? openaiApiKey.trim() : '';
    if (key.length < 20 || /\s/.test(key)) {
      throw new VoiceSettingsError('invalid-api-key', 'Paste the whole OpenAI API key.', 'openaiApiKey');
    }
    next.openaiApiKey = key;
  }
  if (defaultProjectId === null) delete next.defaultProjectId;
  else if (typeof defaultProjectId === 'string' && defaultProjectId.trim() !== '') next.defaultProjectId = defaultProjectId.trim();
  if (rotateToken || typeof next.token !== 'string' || next.token.length < 32) next.token = newVoiceToken();
  if (typeof next.model !== 'string' || next.model.trim() === '') next.model = DEFAULT_VOICE_MODEL;
  writeAtomic(configPath, next);
  return next;
}

/** 설정 화면이 보는 상태. 키는 가리고, 단축어 토큰은 복사할 수 있게 그대로 준다. */
export function voiceSettingsStatus(configPath, env = process.env) {
  const { config, error } = readRaw(configPath);
  const savedKey = typeof config?.openaiApiKey === 'string' && config.openaiApiKey.trim() !== '' ? config.openaiApiKey : null;
  const key = savedKey ?? (env.OPENAI_API_KEY || null);
  const usable = voiceConfigUsable(config);
  return {
    configPath,
    configError: error,
    ready: usable && key !== null,
    model: typeof config?.model === 'string' && config.model.trim() !== '' ? config.model : null,
    defaultModel: DEFAULT_VOICE_MODEL,
    apiKey: {
      source: savedKey ? 'settings' : key ? 'environment' : null,
      preview: maskSecret(key),
    },
    shortcutToken: usable ? config.token : null,
  };
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * 설정 화면의 요청: `POST /rubato/voice/settings/<status|save|rotate-token>`.
 * 인증은 부르는 쪽(T3 서버의 데스크톱 세션)이 이미 했다. 아이폰 토큰으로는 오지 않는다.
 */
export async function handleVoiceSettingsRequest(request, { configPath, env = process.env }) {
  const action = /^\/rubato\/voice\/settings\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
  if (request.method !== 'POST' || !action) return json({ error: { code: 'not-found' } }, 404);
  let body = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return json({ error: { code: 'invalid-json', message: 'Provide a JSON object' } }, 400);
  }
  try {
    if (action === 'status') return json(voiceSettingsStatus(configPath, env));
    if (action === 'save') {
      const patch = {};
      if ('model' in body) patch.model = body.model;
      if ('openaiApiKey' in body) patch.openaiApiKey = body.openaiApiKey;
      updateVoiceConfig(configPath, patch);
      return json(voiceSettingsStatus(configPath, env));
    }
    if (action === 'rotate-token') {
      updateVoiceConfig(configPath, { rotateToken: true });
      return json(voiceSettingsStatus(configPath, env));
    }
    return json({ error: { code: 'not-found' } }, 404);
  } catch (error) {
    if (error instanceof VoiceSettingsError) {
      return json({ error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } }, error.status);
    }
    return json({ error: { code: 'voice-settings-failed', message: 'Could not save the voice settings.' } }, 500);
  }
}
