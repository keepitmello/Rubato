---
name: imagen-proxy
description: "로컬 이미지 프록시와 i2i. gti, wan26."

---

# imagen-proxy

`god-tibo-imagen`은 Codex/ChatGPT 이미지 생성을 감싼 비공식 로컬 래퍼다.

```bash
/Users/wy/Github-repos/god-tibo-imagen   # repo
/Users/wy/.local/bin/gti                 # CLI
```

프로바이더 두 갈래:
- `private-codex`: private ChatGPT/Codex 백엔드 직결 (`~/.codex/auth.json`)
- `codex-cli`: Codex CLI 경유 폴백

기본 모델은 `gpt-5.4`. `--model gpt-5.5`가 품질이 낫고 sanitization이 덜하다.

## CLI 옵션

### 기본
```
--prompt <text>               필수 프롬프트
--output <path>               출력 PNG 경로
--model <name>                gpt-5.4 (기본) | gpt-5.5
--provider <name>             private-codex (빠름) | codex-cli (폴백) | auto
--image <path>                입력 이미지 (i2i, 반복 가능)
--debug --debug-dir <path>    요청/응답 덤프
```

### 세션 연속성 (2026-05-04 추가)
```
--continue, -c                직전 응답에서 이어가기 (turns.json + last-image-path 자동 로드)
--previous-response-id <id>   (예약됨; 백엔드가 store=true를 거부)
--session-id <id>             특정 세션 id 고정
--reset-session               저장된 세션 상태 전부 삭제
--store                       서버 저장 강제 (이 백엔드 미지원 — 400 발생)
```

`~/.gti/` 상태 파일:
- `turns.json` — 누적 user/assistant 대화 이력 (최대 6턴, `MAX_PRIOR_TURNS = 6`이 오래된 턴부터 트림)
- `last-response-id`, `last-session-id` — 기록용
- `last-image-path` — 다음 `--continue` 때 레퍼런스로 자동 첨부

이 백엔드는 `store: true`를 거부한다. 그래서 `previous_response_id`가 아니라 매 호출 `input` 배열에 이전 턴을 인라인해 컨텍스트를 누적한다. 제약: `assistant` 턴에는 `output_text`나 `refusal`만 들어갈 수 있고 `input_image` 블록은 금지다. 그래서 assistant 쪽은 텍스트만 저장하고, 마지막 생성 이미지는 다음 user 턴의 레퍼런스로 자동 첨부한다.

## 검열 메커니즘

- **Revised prompt**: ChatGPT 백엔드가 이미지 생성 전에 프롬프트를 안전 방향으로 재작성한다. 응답 JSON의 `revisedPrompt`에서 보인다. private API에서는 끌 수 없다.
- **계정 누적**: `sessionId`는 호출마다 새로 생기지만 account/installation_id 단위 moderation은 단기 누적된다. 짧은 시간에 비슷한 프롬프트를 반복하면 판정이 강해지고, 시간이 지나면 풀린다. 하드 블록이 걸리면 기다리거나 세션을 리셋한다.

실패 3종:
1. **하드 블록** — 에러 `"response stream completed without an image_generation_call result"`. moderation이 아예 거절.
2. **Sanitize** — 통과는 하지만 실명이 "inspired by"로 재작성됨. 비슷하게 생겼지만 그 사람은 아니다.
3. **경고성 소프트 패스** — revised prompt에 `"tasteful and non-explicit"`가 붙는다. 다음 시도가 하드 블록될 신호.

## 자주 쓰는 커맨드

```bash
gti --help          # README의 `gti --version`은 미구현이다

# 단발 (세션 연속성 없음)
gti --provider private-codex --model gpt-5.5 \
  --prompt "<prompt>" --output ./out.png

# 소요 시간 측정
TIMEFORMAT='elapsed_seconds=%R'; time gti --provider private-codex \
  --prompt "<prompt>" --output ./out.png

# 실제로 뭐가 오갔는지 확인
gti ... --debug --debug-dir ./debug
cat ./debug/request.json
cat ./debug/response.json
```

## 참조

- 트리거/안전 키워드, 골든 포뮬러, GPT Image 공식 프롬프팅 원칙, 텍스트 렌더링: [`references/prompting.md`](references/prompting.md)
- 멀티턴 `--continue` 체인, i2i 노트, 인물 프사 / 정밀 편집 실전 노하우: [`references/i2i-editing.md`](references/i2i-editing.md)
- fal.ai wan26 i2i 러너 (옷 갈아입히기, 옵션, 422 진단): [`references/wan26.md`](references/wan26.md)

## 벤치마크 (2026-05-04 KST)

단순 파란 사각형 프롬프트 — `private-codex` `19.891s`, `codex-cli` `27.597s`. 스모크 결과라 안정적인 수치는 아니다.

## Caveats

- 비공식 private 백엔드. 예고 없이 깨질 수 있다.
- auth 토큰 원문은 붙여넣지 않는다.
- `--store`는 응답을 ChatGPT 서버에 저장한다(`previous_response_id`가 작동하려면 필요). 프라이버시 민감한 프롬프트면 `--continue`를 쓰지 않는다.
