# 맥 음성 입력

아이폰 단축어와 맥 T3 입력창이 **같은 맥의 전사 서비스**를 쓴다. OpenAI 키는
맥에만 있고, 아이폰에는 맥이 만든 토큰만 들어간다. 스토어판 T3 모바일 앱은
손대지 않는다.

## 무엇이 어디에 있나

| 자리 | 맡는 것 |
|---|---|
| `src/voice/` | 전사·대상 고정·세션·전송. T3 없이도 도는 순수 모듈 |
| `overlay/apps/server/src/RubatoVoice.ts` | T3 서버에 `/rubato/voice/*` 라우트를 얹는 자리 |
| `voice-edits.mjs` | 서버·웹에 넣는 최소 수정(라우트 등록, 폰의 대화 구독·활동 보고 연결, 입력창 마이크) |
| `overlay/apps/web/src/state/rubatoVoice.ts` | 맥 입력창의 녹음기와 전사 클라이언트 |
| `src/voice/settings.mjs` | `~/.rubato/voice.json` 을 읽고 쓰는 규칙. 설정 화면과 `voice-setup.mjs` 가 같이 쓴다 |
| `overlay/apps/web/src/components/settings/RubatoVoiceSettings.tsx` | 설정 › 채팅 › 음성 입력 |
| `voice-setup.mjs` | 같은 설정을 터미널에서 심는 도구 |

## 맥

1. **설정 › 채팅 › 음성 입력**에서 OpenAI API 키를 넣는다. 모델은 기본값
   `gpt-transcribe` 그대로 두면 된다. 저장하면 앱을 다시 켜지 않아도 다음 녹음부터
   쓴다 — 서버가 요청마다 `voice.json` 이 바뀌었는지 보고 다시 읽는다.

   터미널에서 하려면:

   ```sh
   node rubato/harness/t3-integration/voice-setup.mjs
   ```

   키는 `--key` → 환경변수 `OPENAI_API_KEY` → 로그인 셸 순으로 찾는다. 설정에 키가
   없으면 앱 환경의 `OPENAI_API_KEY` 를 쓴다. 설정 파일은 0600으로 쓰고, `--show`
   는 키와 토큰을 가려서 보여준다.

   `gpt-transcribe` 가 지금의 파일 전사 권장 모델이다(2026-07-28 출시). 옛
   `whisper-1`·`gpt-4o-transcribe` 계열은 2027-02-26 API 에서 빠질 예정이고,
   전사기는 두 세대를 알아서 갈라 보낸다 — 새 모델에는 `languages[]`·`keywords[]`,
   옛 모델에는 `language`·`response_format`.

   새 대화를 만들 때 쓸 프로젝트를 미리 정해두려면 `--project <projectId>` 를 붙인다.
   대화를 연 채로 한 번 쓰면 그 프로젝트를 기억하므로 보통은 나중에 필요 없다.

2. 서버는 음성 모듈을 Rubato 프로바이더가 쓰는 체크아웃(`bridgeModule` 옆
   `voice/runtime.mjs`)에서 찾는다. 그래서 `voice.json` 에는 기기별 경로가 없고,
   어느 맥이든 그 맥의 체크아웃을 쓴다. 예전 설정의 `module` 은 프로바이더가 없을
   때만 본다.

3. 입력창 오른쪽 마이크 → 말하기 → 정지 → 전사문이 **그때 커서가 있던 자리**에
   들어온다. 고친 뒤 평소처럼 전송한다. 맥에서는 자동으로 보내지 않는다.

   녹음 중에는 `녹음 0:12` 와 정지·취소가 보이고, 끝나면 `전사 중` 이 보인다.
   다른 대화로 옮기면 진행 중이던 녹음은 버려진다. 실패하면 이유가 마이크 옆에
   보이고, 키·모델·미설정처럼 설정에서 고칠 수 있는 것이면 설정으로 가는 버튼이
   같이 뜬다.

   입력창은 T3 서버의 CORS 가 허용하는 메서드(GET·POST)와 헤더만 쓴다. 파일 이름은
   서버가 녹음 형식(`content-type`)으로 정하고, 세션 닫기는 `POST …/cancel` 이다.
   `rubatoVoice.test.ts` 가 T3 의 허용 목록을 직접 읽어 이걸 확인한다.

## 아이폰 단축어

설치형 `.shortcut` 파일은 아직 만들지 않았다. 아래 단계를 단축어 앱에서 그대로
따라 만들면 된다. 주소의 `<맥>`·`<포트>` 는 **아이폰 T3가 연결하는 그 주소**와
같다. 토큰은 설정 › 채팅 › 음성 입력의 **iPhone 단축어 토큰**에서 복사한다.

1. **Get Contents of URL** — `POST http://<맥>:<포트>/rubato/voice/session`
   - Headers: `Authorization` = `Bearer <토큰>`, `Content-Type` = `application/json`
   - Request Body: JSON, `mode` = `mobile`
   - 결과를 변수 `세션` 으로 저장한다. `voiceSessionId`·`target`·`label` 이 들어 있다.
2. **If** `세션.target` 이 `ambiguous` 이면 — 후보가 여러 개라는 뜻이다.
   `세션.candidates` 를 **Choose from List** 로 보여주고 고른 항목의 `threadId` 로
   `POST /rubato/voice/session/<세션.voiceSessionId>/select` (JSON `threadId`) 를 부른다.
   확정된 경우에는 이 단계를 건너뛴다.
3. **Record Audio** — 말한다.
4. **Get Contents of URL** — `POST /rubato/voice/session/<세션.voiceSessionId>/transcribe`
   - Headers: `Authorization`, `Content-Type` = `audio/mp4`, `x-audio-filename` = `voice.m4a`
   - Request Body: **File**, File = 3의 녹음
   - 결과에서 `text` 를 꺼낸다.
5. **Ask for Input** — Text. Prompt 는 "고칠 부분이 있으면 고쳐". Default Answer 가
   보이면 4의 `text` 를 넣는다.
6. **Get Contents of URL** — `POST /rubato/voice/session/<세션.voiceSessionId>/submit`
   - JSON `text` = 5의 답
7. **Open URL** — 6의 결과에 있는 `deepLink`. T3가 그 대화로 열린다.

대상은 단축어를 **실행한 순간** 정해진다. 최근 1분 안에 아이폰 T3에서 보던
대화가 있으면 그 대화로 가고, 여러 기기이거나 재연결처럼 애매한 경우에만
2번에서 고른다. 최근 대화가 없으면 마지막으로 쓴 프로젝트(없으면 `--project`)에
새 대화를 만든다. 모델과 권한 모드는 T3 앱이 새 대화에 쓰는 값 그대로다 —
프로젝트에 정한 값, 없으면 이 맥의 기본값. 제목은 입력창의 첫 메시지처럼
보낸 문장에서 T3가 만든다.

## 서버 계약

| 요청 | 하는 일 |
|---|---|
| `POST /rubato/voice/session` `{mode}` | 세션을 열고 대상을 고정한다. `mode` 는 `mobile`(단축어) 또는 `draft`(맥 입력창) |
| `POST /rubato/voice/session/:id/select` `{threadId}` | 애매할 때만 후보 중에서 고른다 |
| `POST /rubato/voice/session/:id/transcribe` (오디오 본문) | 전사한다. `{text}` 를 돌려준다 |
| `POST /rubato/voice/session/:id/submit` `{text}` | 그 대화로 보낸다. `{status, deepLink}` |
| `GET /rubato/voice/session/:id` | 지금 상태를 본다 |
| `DELETE /rubato/voice/session/:id` 또는 `POST …/:id/cancel` | 아직 안 보낸 세션을 접는다. T3 대기열에서 기다리는 메시지면 대기열에서 뺀다 |
| `POST /rubato/voice/settings/{status,save,rotate-token}` | 설정 화면. 이 맥에 로그인된 창만 쓴다(단축어 토큰으로는 안 된다). 키는 응답에 가려서만 나간다 |

- 인증은 두 갈래다. 아이폰은 `Authorization: Bearer <토큰>`, 맥 입력창은 T3에
  이미 로그인된 세션을 쓴다. 맥 쪽은 `draft` 만 다룰 수 있고 모바일 세션은
  건드리지 못한다.
- 대화가 작업 중이면 메시지는 **T3의 대기열**에 들어간다. 응답은 `queued`(202)이고,
  지금 턴이 끝나면 T3가 이어서 보낸다. 대기 중인 메시지는 입력창에서 보내는 대기
  메시지와 똑같이 보이고, 고치거나 지우거나 Stop 뒤에 Resume 할 수 있다. 바로
  시작되면 `sent`(200)다. 보내지 못한 이유는 대화 안이 아니라 응답의 `error` 에 온다.
- 같은 세션으로 같은 글을 다시 보내면 **다시 보내지 않고** 앞의 결과를 돌려준다.
- 설정 파일이 없거나 모델·토큰이 비면 세션 라우트는 503 `voice-not-configured` 를
  돌려주고 설정 라우트만 동작한다. 키가 없으면 전사가 503 `missing-api-key`, OpenAI 가
  키를 거부하면 502 `api-key-rejected` 다. 서버는 그대로 뜬다.

## 확인한 것과 아직 아닌 것

- 격리한 v0.1.0 체크아웃에서 적용·타입검사(서버·웹)까지 통과했다.
- 모의 T3와 실제 HTTP 왕복으로 대상 고정, 취소·만료, 중복 전송, 새 대화 생성,
  재시작 뒤 이어 보내기를 확인했다(`test/voice-*.test.mjs`).
- T3의 실제 V2 오케스트레이터 위에서 작업 중 대기, 같은 전송의 재시도, 대기열에서
  빼기, 새 대화 생성을 확인했다(`test/voice-orchestrator.test.mjs`, `T3_SOURCE` 필요).
- 격리 서버에서 단축어의 HTTP 단계를 curl 로, 폰의 구독·활동 보고를 WebSocket
  클라이언트로 흉내 내 대상 고정·고르기·작업 중 대기·대기열에서 빼기와 실제
  Rubato 턴을 확인했다.
- 실제 OpenAI 전사: 떠 있는 맥 서버에 `say` 로 만든 한국어 녹음을 올려 전사문을 받았다.
- **아직 아닌 것**: 아이폰 단축어 실사용, 맥 마이크 실사용. 실기기에서 확인해야 한다.
