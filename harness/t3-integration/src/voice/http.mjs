import http from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { VoiceSessionError } from './sessions.mjs';

export function bearerMatches(header, token) {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
async function limitedBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new VoiceSessionError('payload-too-large', 'Upload is too large', 413);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
async function jsonBody(request) {
  let parsed;
  try { parsed = JSON.parse((await limitedBody(request, 256 * 1024)).toString() || '{}'); }
  catch (error) {
    if (error instanceof VoiceSessionError) throw error;
    throw new VoiceSessionError('invalid-json', 'Provide a JSON object', 400);
  }
  // `null` 이나 숫자 같은 값은 여기서 막는다. 아래에서 필드를 읽다 터지면
  // 설정 실수처럼 보이는 502 가 나가고, 클라이언트는 무엇이 틀렸는지 모른다.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VoiceSessionError('invalid-json', 'Provide a JSON object', 400);
  }
  return parsed;
}

// Same handler in T3's authenticated HTTP layer and the isolated real-HTTP test.
// The desktop may only use draft transcription with its existing T3 credential.
export async function handleVoiceRequest(request, { service, token, desktopAuthenticated = false }) {
  const voiceAuthenticated = bearerMatches(request.headers.get('authorization'), token);
  if (!voiceAuthenticated && !desktopAuthenticated) return json({ error: { code: 'unauthorized' } }, 401);
  const path = new URL(request.url).pathname;
  const route = /^\/rubato\/voice\/session\/([^/]+)(?:\/(transcribe|submit|select))?$/.exec(path);
  try {
    if (request.method === 'POST' && path === '/rubato/voice/session') {
      const input = await jsonBody(request);
      if (!voiceAuthenticated && input.mode !== 'draft') return json({ error: { code: 'forbidden' } }, 403);
      return json(await service.startSession(input));
    }
    if (!route) return json({ error: { code: 'not-found' } }, 404);
    const id = route[1];
    if (!voiceAuthenticated && service.status(id).target !== 'draft') return json({ error: { code: 'forbidden' } }, 403);
    if (request.method === 'GET' && !route[2]) return json(service.status(id));
    if (request.method === 'DELETE' && !route[2]) return json(await service.cancel(id));
    if (request.method === 'POST' && route[2] === 'select') {
      const input = await jsonBody(request);
      return json(await service.select(id, input.threadId));
    }
    if (request.method === 'POST' && route[2] === 'submit') {
      const input = await jsonBody(request);
      const result = await service.submit({ voiceSessionId: id, text: input.text });
      return json(result, result.status === 'queued' || result.status === 'sending' ? 202 : 200);
    }
    if (request.method === 'POST' && route[2] === 'transcribe') {
      // Raw files work in Shortcuts without constructing multipart by hand.
      let audio = await limitedBody(request, 25 * 1024 * 1024);
      let contentType = request.headers.get('content-type') ?? 'audio/mp4';
      let filename = request.headers.get('x-audio-filename') ?? 'voice.m4a';
      if (contentType.startsWith('multipart/form-data')) {
        let form;
        try { form = await new Response(audio, { headers: { 'content-type': contentType } }).formData(); }
        catch { throw new VoiceSessionError('invalid-audio', 'Malformed audio upload', 400); }
        const file = form.get('file');
        if (!(file instanceof Blob)) throw new VoiceSessionError('missing-audio', 'Send audio in the file field', 400);
        filename = file.name;
        contentType = file.type;
        audio = Buffer.from(await file.arrayBuffer());
      }
      return json(await service.transcribe({ voiceSessionId: id, audio, contentType, filename }));
    }
    return json({ error: { code: 'not-found' } }, 404);
  } catch (error) {
    if (error instanceof VoiceSessionError) return json({ error: { code: error.code, message: error.message } }, error.status);
    // Never reflect upstream responses, tokens or arbitrary exception messages.
    return json({ error: { code: 'voice-failed', message: 'Voice service could not complete the request' } }, 502);
  }
}

export function createVoiceHttpServer(options) {
  if (!options.token || options.token.length < 32) throw new Error('Use a voice token of at least 32 characters');
  return http.createServer(async (incoming, outgoing) => {
    try {
      const request = new Request(`http://voice.local${incoming.url}`, {
        method: incoming.method, headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} :
          { body: Readable.toWeb(incoming), duplex: 'half' }),
      });
      const response = await handleVoiceRequest(request, options);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
}
