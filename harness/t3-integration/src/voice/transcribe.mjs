// 맥에서만 도는 전사 호출. OpenAI 키는 여기(맥)에만 있고 아이폰에는 없다.
//
// 모델 id는 **설정에서 받는다.** 추측한 이름을 코드에 박지 않는다 — 없는 모델을
// 박아 두면 첫 실행에서 404가 나고, 그 404는 "설정이 비었다"와 구별되지 않는다.
// 설정이 없으면 여기서 분명한 이름으로 실패한다.

export const TRANSCRIPTION_INSTRUCTIONS = [
  'The speaker is dictating a work message in a chat with a coding agent.',
  'Write what was said. Do not summarize, translate, reorder or polish it.',
  'The primary language is Korean. Keep English technical terms, product names, model names and file names in their original English spelling.',
].join(' ');

/** 자주 나오는 이름들. 오타로 굳는 것을 줄이는 용도다. */
export const DEFAULT_HINTS = [
  'Rubato', 'T3', 'Codex', 'Claude', 'Fable', 'Astra', 'DeepSeek', 'Grok',
  'Supabase', 'Redis', 'TypeScript', 'Node.js', 'GitHub', 'Playwright',
];

export function buildTranscriptionPrompt({ hints = DEFAULT_HINTS, extra = null } = {}) {
  const words = transcriptionKeywords(hints);
  const lines = [TRANSCRIPTION_INSTRUCTIONS];
  if (words.length) lines.push(`Spellings to prefer: ${words.join(', ')}.`);
  if (extra) lines.push(String(extra));
  return lines.join('\n');
}

/**
 * 단어 힌트를 `keywords` 로 쓸 수 있게 다듬는다. OpenAI 는 `<`, `>`, 캐리지리턴,
 * 줄바꿈이 들어 있으면 요청 전체를 거부하므로 여기서 걸러낸다.
 */
export function transcriptionKeywords(hints) {
  return [...new Set((hints ?? [])
    .filter((word) => typeof word === 'string')
    .map((word) => word.trim())
    .filter((word) => word !== '' && !/[<>\r\n]/.test(word)))];
}

export class TranscriptionError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    this.status = status;
  }
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * 이 세대부터 언어를 배열로 받는다. 단수 `language` 와 함께 보내면 오류다.
 * 배열은 브래킷 형식(`languages[]`)으로 직렬화한다 — OpenAI 의 공식 SDK 가 그렇게
 * 보내고, 같은 페이지의 다른 배열 파라미터 curl 예시도 전부 그 형식이다.
 */
const LANGUAGES_ARRAY_PREFIX = 'gpt-transcribe';

/**
 * 언어를 어떻게 보낼지는 모델 세대가 정한다. `gpt-transcribe`(2026-07-28 출시)는
 * `languages` 배열을 받고, 옛 모델(`whisper-1`, `gpt-4o-*`)은 단수 `language` 를
 * 받는다. 둘 다 보내면 오류다. 단어 힌트도 마찬가지다 — 새 모델은 `keywords`
 * 배열을 받고, 옛 모델에는 프롬프트 안에 넣어야 한다. 25MB 상한과 지원 형식은
 * 두 세대가 같다.
 *
 * 근거(2026-09-22 확인):
 *   developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
 *   platform.openai.com/docs/guides/speech-to-text
 */
function appendTranscriptionFields(form, { model, languages, keywords }) {
  if (model.startsWith(LANGUAGES_ARRAY_PREFIX)) {
    for (const tag of languages) form.append('languages[]', tag);
    for (const word of keywords) form.append('keywords[]', word);
    return;
  }
  form.append('language', languages[0]);
  // 옛 모델의 문서에만 있는 필드다. 새 모델은 기본값을 쓰고, 아래에서 본문을
  // 관대하게 읽는다.
  form.append('response_format', 'json');
}

/**
 * 오디오 한 조각을 글로.
 * `fetchImpl`은 주입받는다 — 그래야 시험이 실제 API를 치지 않고 경로를 확인한다.
 */
export async function transcribeAudio({
  fetchImpl = fetch,
  apiKey,
  model,
  audio,
  filename = 'voice.m4a',
  contentType = 'audio/mp4',
  prompt = null,
  hints = DEFAULT_HINTS,
  languages = ['ko', 'en'],
  baseUrl = 'https://api.openai.com/v1',
  timeoutMs = 120000,
} = {}) {
  if (!apiKey) throw new TranscriptionError('missing-api-key', 'No OpenAI API key is configured on this Mac');
  if (!model) throw new TranscriptionError('missing-model', 'No transcription model is configured (voice.model)');
  if (!audio || audio.length === 0) throw new TranscriptionError('empty-audio', 'The upload contained no audio');
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('audio-too-large', `Audio exceeds ${MAX_AUDIO_BYTES} bytes`);
  }

  const form = new FormData();
  form.append('file', new Blob([audio], { type: contentType }), filename);
  form.append('model', model);
  const keywords = transcriptionKeywords(hints);
  const modern = model.startsWith(LANGUAGES_ARRAY_PREFIX);
  // 새 모델은 힌트를 `keywords` 로 받으므로 프롬프트에 같은 말을 겹쳐 넣지 않는다.
  const instructions = prompt ?? buildTranscriptionPrompt({ hints: modern ? [] : hints });
  if (instructions) form.append('prompt', instructions);
  if (languages.length) {
    appendTranscriptionFields(form, { model, languages, keywords: modern ? keywords : [] });
  }

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new TranscriptionError('transcription-unreachable', `Transcription request failed: ${cause?.message ?? cause}`);
  }
  if (!response.ok) {
    // 본문에 키가 들어오지 않는다. 그래도 길이는 자른다.
    const detail = await response.text().catch(() => '');
    throw new TranscriptionError(
      'transcription-rejected',
      `Transcription failed with ${response.status}: ${detail.slice(0, 300)}`,
      response.status,
    );
  }
  const body = await response.text();
  let text = body;
  try {
    const payload = JSON.parse(body);
    if (typeof payload?.text === 'string') text = payload.text;
  } catch { /* JSON 이 아니면 본문이 곧 전사문이다 */ }
  text = text.trim();
  if (!text) throw new TranscriptionError('empty-transcription', 'The transcription came back empty');
  return { text };
}
