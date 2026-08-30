---
name: rubato-tui-verify
description: "Rubato/senpi TUI 렌더링을 검증할 때 — 사고 블록 접힘·펼침, 도구 출력, 마우스 토글. 세션을 띄우기 전에 컴포넌트 층에서 먼저 본다."
---

# Rubato TUI Verify

senpi TUI 의 렌더링이 의도대로인지 확인하는 자리. **세션을 띄우는 것은 마지막 수단이다.**

## 층을 고른다

| 층 | 무엇을 잡나 | 비용 | 언제 |
|---|---|---|---|
| 1. 컴포넌트 | 무엇이 그려지고 무엇이 안 그려지나 | 0.3초, 토큰 0 | 기본값 |
| 2. 입력 | 클릭·드래그·토글 | 0.3초, 토큰 0 | 마우스가 얽힐 때 |
| 3. 실세션 PTY | 설정이 실제로 로드되나, 통합 | 분 단위, 토큰 소모 | 1·2 로 못 닿는 것만 |

1층에서 답이 나오면 3층은 하지 않는다. 반대로 **"설정 파일 값이 실제 세션에 먹히나"는 1층이 절대 답할 수 없다** — 그것만 3층으로 간다.

## 1층: 컴포넌트를 직접 렌더

`scripts/render-component.mjs` 가 실물 컴포넌트를 띄워 화면 문자열을 찍는다.

```bash
node ~/.agents/skills/rubato-tui-verify/scripts/render-component.mjs --demo thinking
node ~/.agents/skills/rubato-tui-verify/scripts/render-component.mjs --demo thinking --expand
node ~/.agents/skills/rubato-tui-verify/scripts/render-component.mjs --demo thinking --raw   # OSC8 링크 확인
```

접힘이면 `Thought: 1.2s` 라벨만, `--expand` 면 그 아래로 사고 본문이 나온다. 이 둘이 다르면 접기가 살아 있는 것이다.

레포 위치가 다르면 `RUBATO_REPO=/path/to/Rubato`.

## 2층: 클릭·토글까지

테스트에서 실물을 띄우고 `dispatchInternalAction` 으로 토글을 누른다. 본보기는 레포 안에 이미 있다:

- `harness/rubato-pi/test/unit/thinking-stream.test.mjs` — 사고가 펼친 안쪽에서 자라는지
- `harness/rubato-pi/test/unit/collapsible-mouse.test.mjs` — 클릭·드래그·선택 복사

로더 변환(OSC8 마커 주입)이 걸린 실물이 필요하면 `--import harness/rubato-pi/src/no-changelog-register.mjs` 로 돈다. **단순 렌더 확인에는 로더가 필요 없다.**

## 함정 (전부 실제로 밟은 것)

- **테마 초기화.** `initTheme("dark")` 를 먼저 안 부르면 사고 라벨을 그리다 `Theme not initialized` 로 던진다.
- **`stopReason` 필수.** 메시지에 없으면 디스크립터 빌더가 `assertNever` 로 던진다. `"stop"` 이면 된다.
- **빈 `thinking` 은 디스크립터가 아예 안 생긴다.** 스트리밍 첫 프레임을 흉내 낼 때 빈 문자열로 시작하면 렌더가 비어서 오판한다.
- **줄 0 은 셸 통합 마커다.** 사고 라벨은 줄 1 에 있다. 고정 인덱스로 링크를 찾지 말고 전 줄을 훑어라.
- **`node_modules` 사본이 여러 벌이다.** 실제로 도는 것은 레포 루트 쪽이고 `harness/rubato-pi/node_modules` 쪽에는 없는 필드가 있다. 어느 사본을 읽는지 먼저 확정한다 — 이걸 틀려서 멀쩡한 토글을 "없다"고 오진한 적이 있다.
- **자식 프로세스 테스트는 status 만 보면 거짓말한다.** `spawnSync` 가 0 을 줘도 자식이 통째로 안 돌았을 수 있다. 통과 개수를 세라. 부모 러너가 리포터를 물려주므로 `NODE_TEST*` 환경변수를 지우고 `--test-reporter=spec`, `stdio: ["ignore","pipe","pipe"]` 로 띄운다.

## 3층: 실세션

`bash` 도구가 이미 PTY 다. **tmux 를 끼우지 마라** — cmux 가 tmux 서버에 `TERM=dumb` 을 박은 이력이 있다.

```
bash({ command: "cd /tmp && RUBATO_NO_VAULT=1 <repo>/harness/scripts/rubato-pi.sh",
       run_in_background: true, cols: 120, rows: 40 })
bash_input({ bash_id, input: "사고를 길게 뽑는 질문", submit: true })
bash_output({ bash_id, view: "screen" })
```

사고를 길게 뽑으려면 **어려운 문제**를 줘야 한다(12동전 문제 등). adaptive 는 쉬운 요청에서 사고를 건너뛰므로 trivial 프롬프트로 재면 "사고 안 함"으로 오판한다. 상태줄의 `think Xs` 가 실제 사고 시간이다.

끝나면 `kill_bash`.

## 판정할 때

"안 샌다"와 "안쪽에서 흐른다"는 다른 명제다. 접힌 화면이 깨끗한 것만 보고 스트리밍이 된다고 하지 마라 — **펼쳐서 안쪽이 자라는 것까지 봐야 한다.** 실제로 이걸 빠뜨려서 반쪽만 검증한 적이 있다.

새 검증을 붙일 때는 고의로 코드를 망가뜨려 그 테스트가 실패하는지 한 번 확인한다. 실패하지 않는 테스트는 통과해도 아무것도 말해주지 않는다.
