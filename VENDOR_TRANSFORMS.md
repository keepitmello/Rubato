# Vendor Transforms — 벤더 패치 오버레이 철거 기록과 유지보수 가이드

2026-08-31 ~ 09-01. 커밋 체인 `ca4b6fbbf..78c9b2310` (12개).

## 무엇을 했나

`node_modules` 를 직접 고치던 벤더 패치 39장(senpi baseline + 시리즈 31, senpi-tui,
pi-ai baseline + 시리즈 4, senpi-codemode)을 전부 걷어내고, 같은 행동을 레포 안의
load transform 으로 옮겼다. `patches/`, `postinstall.mjs` 의 패치 로직,
`vendor-patch.mjs`, `patch-tests/`(229개)는 삭제됐다. 설치본은 이제 순정이다.

행동 변화 0 이 목표였고, 전환 내내 `transform(pristine) === 패치된 바이트`
동등성 테스트로 못 박은 뒤에 플립했다 (그 발판 테스트들은 패치와 함께 은퇴).

## 지금 구조

```
세션 기동 (launch.mjs withNoChangelog)
  → NODE_OPTIONS --import no-changelog-register.mjs
  → no-changelog-hooks.mjs load(url, ...)
      1. 클러스터 변환 (transforms/*.mjs) — 예전 패치의 행동을 재구성
      2. 레거시 변환 (busy-enter, footer, collapsible-mouse, stripChangelog, ...)
```

순서가 불변식이다: 클러스터가 먼저 pristine 소스를 "패치된 것과 같은" 텍스트로
만들고, 레거시 변환은 그 텍스트에서 예전과 같은 니들을 찾는다. 니들이 안 맞으면
throw 하지만 `applyTransform` 이 `RubatoTransformDrift` 경고로 삼킨다 — 세션은
살고, 해당 꾸밈만 빠진다.

### 클러스터 (harness/rubato-pi/src/transforms/)

| 클러스터 | 파일 접두 | 옮긴 패치 |
|---|---|---|
| tui-chrome | (없음: assistant-*, tool-*, interactive-mode-chrome, transcript-cache, turn-work-summary, internal-actions) | TUI 접기/펼치기, turn-work 요약, thinking 라이프사이클, abort-once, 트랜스크립트 캐시 |
| misc-vendor | `misc-` | 모델 피커 정렬/라벨, high-reasoning 경고 제거, auth 원자/내구 쓰기, pi-tui 인라인 /skill: 자동완성, pi-ai lazy local-work, GPT-5.6 캐시 TTL |
| core-session | `core-` | compaction 4부작 + 예산, retry/stream watchdog, /skill: 인라인, user-abort 후 compact, speculative 제거, service-tier fast 기억, Codex overflow 감지, 모델별 client compact 임계점 |
| cursor-vendor | `cursor-` | cursor-exec journal 3부작, terminal-failure-kind, native checkpoint |
| control-codemode | `control-` | interactive-control-surface(#29), codemode jiti 리다이렉트 |

### 패치가 "만들던" 파일 — in-repo 모듈이 정본

load transform 은 없는 모듈을 만들지 못한다. 이 넷은 레포 모듈로 이사했고,
임포터 쪽 벤더 파일을 변환해 in-repo `file://` href 로 돌린다 (footer 패턴):

- `transforms/tool-group-component.mjs`
- `transforms/turn-work-summary.mjs`
- `transforms/internal-actions.mjs`
- `transforms/cursor-exec-journal.mjs` (`cursor-exec-notice.mjs` 도 이걸 읽는다)

### codemode 는 로더 밖 — jiti 리다이렉트

senpi-codemode 는 source-only TS 라 Node ESM 훅이 못 닿는다 (senpi 가 jiti 로
`src/*.ts` 를 직접 읽음). 대신 `loader.js` 변환이 jiti 에 in-repo 패치본을 먹인다:
엔트리는 `evalModule`(filename 을 벤더 경로로 고정해 상대 import 는 벤더로 감),
`eval-notifier.ts` 만 alias. 사본: `harness/rubato-pi/src/codemode/`.

## 가드

- **`test/unit/installed-engine-transforms.test.mjs`** — 설치본 32개 파일 전부에
  실제 `load()` 를 돌려 (1) 변환이 실제로 일어나고 (2) 드리프트 경고 0 을 단언.
  **엔진 버전을 올리면 여기가 가장 먼저 무너지고, 어긋난 파일을 지목한다.**
- 행동 테스트: `collapsible-mouse` / `thinking-stream` (로더 체인 통과한 실물
  컴포넌트), `control-codemode-redirect`(jiti 프로브), `tui-chrome-components`,
  `transform-drift`.

## 엔진 버전 올릴 때

1. 핀 갱신 후 설치 → `npm --prefix harness/rubato-pi test`
2. `installed-engine-transforms` 가 어긋난 파일을 말해준다 → 해당
   `transforms/*.mjs` 의 니들을 새 소스에 맞게 수정
3. upstream 이 이미 흡수한 수정(auth 원자 쓰기, lazy local-work, TTL 등)은
   그 transform 을 그냥 삭제
4. `cursor-agent.js` 는 checkpoint echo / RequestContext pin / read-image /
   Task 문구의 작은 니들만 쓴다. 통파일 치환은 senpi 가 import·blob cap 을
   넣자 첫 바이트에서 빗나가 checkpoint 메아리가 통째로 빠졌다 — 다시 키우지 않는다

패치 재작성(re-cut)은 더 이상 없다.

## 받아들인 트레이드오프

- `.d.ts` 패치 헌크는 안 옮김 — 타입 선언은 런타임에 로드되지 않고 하네스는 JS.
- `stripChangelog` 의 무음 `.replace()` 는 레거시 그대로 (개별 니들 드리프트 신호
  없음). 실효 낮아 수용.
- 자식 프로세스 reach 를 직접 검증하는 spawn 테스트는 미작성 (spawn-payload 유닛
  테스트가 NODE_OPTIONS 상속을 단언하는 선에서 수용).

## 부수 수정

- 메모리 자식(reflection/dream/facts)이 훅을 떼고 뜨던 것(`withoutTuiLoaderHooks`)
  제거 — 드리프트가 throw 이던 시절의 방어였고, 이제는 떼면 순정 행동이 된다.
- CI(`remote-stage9-ci.yml`)와 릴리즈 빌더의 `bun test patch-tests` →
  `npm --prefix harness/rubato-pi test`.

## 남은 것

1. **순정 pi 리베이스 (장기 목표의 본편).** senpi 는 pi coding-agent 의 캘린더
   버전 포크다 (`@earendil-works/pi-*` 를 `@code-yeongyu/senpi-*@2026.8.22` 로
   alias). 목표는 `@earendil-works/pi-coding-agent` 실 semver 기반 + 어댑터.
   이번 작업으로 어댑터 표면이 전부 `transforms/` + `codemode/` 에 모였다.
   순정 pi 가 없는 것: task/subagent(=Agent 런타임), team/DAG, compaction 복구,
   cursor 신뢰성, interactive control, codemode.
2. **task→agent 마이그레이션과의 접점.** `UNGROUPED_TOOLS` /
   `ALWAYS_EXPANDED_TOOLS` / slash 목록의 `task`·`tasks`·`task-kill` 문자열이
   transform 안에 글자 그대로 남아 있다. rename 마무리는 이제 벤더 패치가 아니라
   `transforms/tool-group-component.mjs` / `interactive-mode-chrome.mjs` /
   `tool-execution.mjs` 만 고치면 된다.
3. upstream PR 후보: auth 원자/내구 쓰기, pi-ai lazy local-work, GPT-5.6 캐시
   TTL, Codex overflow 감지 — 받아들여지면 transform 삭제.
