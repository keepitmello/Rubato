# 맥 음성 입력

아이폰 단축어와 맥 T3 입력창이 **같은 맥의 전사 서비스**를 쓴다. OpenAI 키는
맥에만 있고, 아이폰에는 맥이 만든 토큰만 들어간다. 스토어판 T3 모바일 앱은
손대지 않는다.

## 무엇이 어디에 있나

| 자리 | 맡는 것 |
|---|---|
| `src/voice/` | 전사·대상 고정·세션·전송. T3 없이도 도는 순수 모듈 |
| `overlay/apps/server/src/RubatoVoice.ts` | T3 서버에 `/rubato/voice/*` 라우트를 얹는 자리 |
| `voice-edits.mjs` | 서버·웹에 넣는 최소 수정(라우트 등록, 구독·활동 보고 연결, 입력창 마이크) |
| `overlay/apps/web/src/state/rubatoVoice.ts` | 맥 입력창의 녹음기와 전사 클라이언트 |
| `voice-setup.mjs` | `~/.rubato/voice.json` 을 만드는 설정 도구 |

## 맥

1. 설정을 심는다. 모델 id와 OpenAI 키는 여기서만 들어간다.

   ```sh
   node rubato/harness/t3-integration/voice-setup.mjs --model gpt-transcribe
   ```

   키는 `--key` → 환경변수 `OPENAI_API_KEY` → 로그인 셸 순으로 찾는다. 셸이
   `~/.zshrc`에서 소스하는 키를 그대로 쓰므로 보통은 붙일 게 없다. 어디서 읽었는지는
   실행 결과에 (가린 값과 함께) 찍힌다. 설정 파일은 0600으로 쓰고, `--show`는 키와
   토큰을 가려서 보여준다.

   `gpt-transcribe` 가 지금의 파일 전사 권장 모델이다(2026-07-28 출시). 옛
   `whisper-1`·`gpt-4o-transcribe` 계열은 2027-02-26 API 에서 빠질 예정이고,
   전사기는 두 세대를 알아서 갈라 보낸다 — 새 모델에는 `languages[]`·`keywords[]`,
   옛 모델에는 `language`·`response_format`.

   새 대화를 만들 때 쓸 프로젝트를 미리 정해두려면 `--project <projectId>` 를 붙인다.
   대화를 연 채로 한 번 쓰면 그 프로젝트를 기억하므로 보통은 나중에 필요 없다.

2. T3 데스크톱 앱을 다시 시작한다. 라우트와 입력창은 앱 번들에 들어가므로
   다시 만들고 다시 켜야 보인다.

3. 입력창 오른쪽 마이크 → 말하기 → 정지 → 전사문이 **그때 커서가 있던 자리**에
   들어온다. 고친 뒤 평소처럼 전송한다. 맥에서는 자동으로 보내지 않는다.

   녹음 중에는 `녹음 0:12` 와 정지·취소가 보이고, 끝나면 `전사 중` 이 보인다.
   다른 대화로 옮기면 진행 중이던 녹음은 버려진다.

## 아이폰 단축어

설치형 `.shortcut` 파일은 아직 만들지 않았다. 아래 단계를 단축어 앱에서 그대로
따라 만들면 된다. 주소의 `<맥>`·`<포트>` 는 **아이폰 T3가 연결하는 그 주소**와
같다. 토큰은 `voice-setup.mjs` 가 마지막에 찍어준다.

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
2번에서 고른다. 최근 대화가 없으면 새 대화를 만들고 그 프로젝트의 기본 설정으로
첫 메시지를 보낸다.

## 서버 계약

| 요청 | 하는 일 |
|---|---|
| `POST /rubato/voice/session` `{mode}` | 세션을 열고 대상을 고정한다. `mode` 는 `mobile`(단축어) 또는 `draft`(맥 입력창) |
| `POST /rubato/voice/session/:id/select` `{threadId}` | 애매할 때만 후보 중에서 고른다 |
| `POST /rubato/voice/session/:id/transcribe` (오디오 본문) | 전사한다. `{text}` 를 돌려준다 |
| `POST /rubato/voice/session/:id/submit` `{text}` | 그 대화로 보낸다. `{status, deepLink}` |
| `GET /rubato/voice/session/:id` | 지금 상태를 본다 |
| `DELETE /rubato/voice/session/:id` | 아직 안 보낸 세션을 접는다 |

- 인증은 두 갈래다. 아이폰은 `Authorization: Bearer <토큰>`, 맥 입력창은 T3에
  이미 로그인된 세션을 쓴다. 맥 쪽은 `draft` 만 다룰 수 있고 모바일 세션은
  건드리지 못한다.
- 대화가 작업 중이면 보내지 않고 **대기**한다. 턴이 끝나면 자동으로 나가고,
  대기·전송·실패는 대화 안에 안내로 남는다.
- 같은 세션으로 같은 글을 다시 보내면 **다시 보내지 않고** 앞의 결과를 돌려준다.
- 설정 파일이 없으면 라우트는 꺼진 채 503을 돌려준다. 서버는 그대로 뜬다.

## 확인한 것과 아직 아닌 것

- 격리한 고정 버전 체크아웃에서 적용·타입검사(서버·웹)까지 통과했다.
- 모의 T3 엔진과 실제 HTTP 왕복으로 대상 고정, 취소·만료, 중복 전송, 작업 중
  대기, 새 대화 생성을 확인했다.
- **아직 아닌 것**: 아이폰 단축어 실사용, 맥 마이크 실사용, 실제 OpenAI 전사
  호출, T3 실엔진에서의 대기 동작. 이 넷은 실기기에서 확인해야 한다.
