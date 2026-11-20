// 실시간 받아쓰기의 1회용 열쇠. 맥이 OpenAI 키로 짧게 사는 client secret 을 받아
// 폰과 데스크탑에 건네고, 둘은 그 열쇠로 OpenAI 실시간 전사에 직접 붙는다(WebRTC).
// 진짜 키는 맥을 떠나지 않는다.
//
// 모델은 단어 단위로 글자를 흘려 주는 `gpt-live-transcribe` 다. 파일 전사 모델
// (`gpt-transcribe`)도 같은 연결에 붙지만 말이 멈춘 뒤에야 문장째 온다. 둘을 같은
// 음성으로 나란히 재 보고 사용자가 단어 단위를 골랐다(2026-11-20). 통화(call-agent)도
// 같은 모델이다. 실시간 전용 모델이라 서버의 쉼 감지(turn_detection)는 받지 않는다.
//
// 근거(2026-11-20 실측): POST /v1/realtime/client_secrets 로 session.type 'transcription'
// 을 만들면 `ek_…` 가 오고, 그 열쇠로 POST /v1/realtime/calls (SDP) 가 붙어 데이터 채널
// `oai-events` 로 `conversation.item.input_audio_transcription.delta` 가 단어마다 온다.
import { DEFAULT_HINTS, TranscriptionError, transcriptionInstructions, transcriptionKeywords } from './transcribe.mjs';

export const LIVE_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';

/**
 * 단어를 내보내기 전에 모델이 소리를 얼마나 더 듣는지. 같은 23초 한국어 음성으로 재면 단어를 다
 * 말한 뒤 화면에 뜨기까지 가운데값이 minimal 0.44초, low 0.76초, 지정 안 함(medium) 1.03초, high
 * 1.31초였고 받아쓴 글은 거의 같았다(2026-11-20). ChatGPT보다 늦다는 사용자 말에 minimal 로 둔다.
 * 정지 때 들어가는 최종본은 모델이 다시 확정한 글이다.
 */
export const LIVE_TRANSCRIPTION_DELAY = 'minimal';

/** 열쇠가 연결을 여는 데 쓰일 수 있는 시간. 연결이 열린 뒤에는 끝나도 세션은 이어진다. */
export const LIVE_SECRET_TTL_SECONDS = 60;

/** 열쇠를 받은 쪽이 SDP 를 보낼 곳. */
export const LIVE_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** OpenAI 에 보낼 전사 세션 설정. 시험이 같은 값을 본다. */
export function liveSessionConfig({ model = LIVE_TRANSCRIPTION_MODEL, hints = DEFAULT_HINTS, languages = ['en'] } = {}) {
  return {
    type: 'transcription',
    audio: {
      input: {
        transcription: {
          model,
          prompt: transcriptionInstructions(languages),
          keywords: transcriptionKeywords(hints),
          languages,
          delay: LIVE_TRANSCRIPTION_DELAY,
        },
        // 폰을 입에 대고 말하는 거리. 통화처럼 스피커 소리가 섞이는 자리가 아니다.
        noise_reduction: { type: 'near_field' },
      },
    },
  };
}

/** 실시간 전사 연결 하나를 열 수 있는 1회용 열쇠를 받는다. */
export async function mintLiveTranscription({
  fetchImpl = fetch,
  apiKey,
  baseUrl = 'https://api.openai.com/v1',
  timeoutMs = 15000,
  ...session
} = {}) {
  if (!apiKey) throw new TranscriptionError('missing-api-key', 'No OpenAI API key is configured on this Mac');
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: LIVE_SECRET_TTL_SECONDS },
        session: liveSessionConfig(session),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new TranscriptionError('transcription-unreachable', `Live transcription setup failed: ${cause?.message ?? cause}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new TranscriptionError(
      'transcription-rejected',
      `Live transcription setup failed with ${response.status}: ${detail.slice(0, 300)}`,
      response.status,
    );
  }
  const payload = await response.json().catch(() => null);
  if (typeof payload?.value !== 'string' || !payload.value) {
    throw new TranscriptionError('transcription-rejected', 'Live transcription setup returned no secret');
  }
  return {
    clientSecret: payload.value,
    expiresAt: typeof payload.expires_at === 'number' ? payload.expires_at * 1000 : null,
    model: payload.session?.audio?.input?.transcription?.model ?? LIVE_TRANSCRIPTION_MODEL,
    callsUrl: LIVE_CALLS_URL,
  };
}
