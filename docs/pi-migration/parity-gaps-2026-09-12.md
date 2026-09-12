# stock-pi 전환 이후 누락 장부 (2026-09-12)

> **진행 상태 (2026-09-12 저녁)** — A·B·remote-surface는 같은 날 처리됐다. 실측 결과는
> `parity-measure-2026-09-12.md`, 비-TUI 43개 판정은 `non-tui-transforms-triage-2026-09-12.md`가
> 정본이다. 새 feature: `turn-chrome`(A의 9건), `tui-autocomplete`·`model-picker`·`thinking-levels`·
> `transcript-cache`·`title-guard`, `statusline`(B). `busy-enter`·`core-session-list-page`·splash 인계는
> 이미 feature에 있었고, A3·busy-enter는 `tui-input` 모듈 이중 import(factory vs dist 복사본)로 꺼져
> 있던 것을 고쳤다. remote-surface는 설치 시 `protocol.mjs`를 동봉해 설치본 부팅 오류 0. 남은 것은
> triage의 "대체 없음" 13건(조용한 동작 차이)과 statusline의 live speed-index.

실사용 기본 엔진이 stock-pi로 넘어간 뒤(`615f6dd61`, 2026-09-11 13:47Z) 사용자가 일상
사용에서 체감한 누락을 역추적한 장부다. 이 문서는 **무엇이 빠졌는지와 왜 빠졌는지**의
현재 답이고, 복구 작업의 진입점이다. 전환 자체의 기록은 lab
`case-studies/runtime-migration/2026-09-11-stock-pi-cutover-record.md`, TUI 트랜스폼의
원본 분류 증거는 `harness/pi-runtime/features/tui-input/transforms-classification.md`가
각각 정본이며 여기서 복제하지 않는다.

## 사용자 관찰 (재현됨)

PTY 캡처로 재현한 실제 부팅 화면:

- 부팅 직후 한 줄: `[rubato-remote-surface] start failed: Error: rubato-remote-protocol checkout was not found`
- 푸터가 stock `FooterComponent` 그대로(`/private/tmp 0.0%/1.0M (auto) … claude-opus-5 • high`)
- 상단 도움말이 stock Pi 문구(`pi v0.85.1`, `Pi can explain its own features…`)
- 도구 호출이 묶이지 않고 낱개로 나열됨

## 원인 — 트랜스폼 75개가 통째로 비활성

senpi 경로는 `no-changelog` ESM 로더를 `NODE_OPTIONS`에 심어 모듈 로드를 가로채고
`harness/rubato-pi/src/transforms/`의 75개 트랜스폼을 주입했다. stock-pi 경로는 실행 직전
그 로더를 환경에서 제거한다.

- `harness/rubato-pi/src/launch.mjs:256-295` — `STRIP_SENPI_KEYS` 삭제 +
  `stripNoChangelogNodeOptions`로 `--import …no-changelog-register` 토큰 제거, 남은 값이
  없으면 `NODE_OPTIONS` 자체를 삭제
- `harness/rubato-pi/src/launch.mjs:309-310` — `runSameNode(..., { stockPi: true })`에서
  `applyStockPiProcessEnv` 적용, `registerNoChangelog`는 senpi 분기에서만 true

따라서 stock-pi에서는 트랜스폼이 하나도 걸리지 않는다. 이는 버그가 아니라 설계된 경계다
(스티커식 소스 패치를 버리고 정식 feature로 재구현하는 방향). 문제는 **재구현이 33개
feature까지만 진행된 상태에서 기본 엔진이 전환된 것**이다. 설치 영수증은 여전히
`"mode": "isolated-candidate"`, `"fullRubatoParity": false`이고,
`docs/pi-migration/tools.md:177`은 전체 E2E 통과 전 실사용 기본 엔진 전환을 금지하고 있었다.

### 75개 교차 대조

`transforms-classification.md`의 판정을 `src/transforms/`의 실제 파일 75개에 경로 기준
정확 매칭으로 대조한 결과:

| 분류 | 수 | 의미 |
| --- | ---: | --- |
| must port: functional | 15 | 옮겨야 한다고 판정됐고 아직 feature로 없음 |
| decoration: skip | 11 | 장식으로 판정해 제외 (사용자는 일부 복구를 원함) |
| dropped (비-TUI) | 43 | TUI가 아니라는 이유로 분류 대상에서 제외 — **parity 측정 안 됨** |
| frozen | 2 | `core-session`, `core-prompt-noise` — 분류표가 편집 대상 아님으로 명시 |
| 미분류 | 4 | `core-replace`, `replace-once`, `misc-replace`(공용 헬퍼), `misc-vendor`(클러스터 디스패처) |

분류표 전체로 보면 must-port 판정은 **19행**이다. `src/transforms/` 밖의 4건이 더 있다 —
`busy-enter`, `title-guard`(둘 다 `src/*.mjs`), 그리고 unicode stdin decode(A1)·클립보드
이미지(A3)다. 뒤의 둘은 `features/tui-input`으로 이식 경로가 이미 잡혀 있다.

## 작업 범위 (사용자 확정, 2026-09-12)

- **한다**: 아래 A(기능 누락 19건)와 B(복구 대상 장식)
- **안 한다**: `builtin-inventory.json`의 `needed-missing` 16종 슬래시 명령
  (`goal`, `diff`, `files`, `help`, `history-search`, `model-fallback`, `redraws`, `loop`,
  `ttsr`, `btw`, `gpt-account`, `import-repro` 등) — 이번 범위 밖
- **하지 않는다**: senpi 롤백. 사용자가 명시적으로 배제했다. `fullRubatoParity`를 true로
  올리는 것도 이 작업의 완료 조건이 아니다

### A. 기능 누락 — must port 19건

| 트랜스폼 | 사용자에게 보이는 증상 |
| --- | --- |
| `tool-group-component` | 도구 호출이 묶이지 않고 낱개로 나열됨 |
| `tool-execution` | todo/task 항상 펼침·접힌 첫 줄 크롬 없음 |
| `interactive-mode-chrome` | 그룹핑·turn-work·working-phase·abort-once 배선 전체 없음 |
| `turn-work-summary` | 턴마다 읽던 thinking/도구 요약 없음 |
| `working-phase` | Thinking과 Working 구분 없이 idle까지 Working 유지 |
| `assistant-message` / `assistant-descriptors` / `assistant-phase` / `core-descriptors` | 턴별 thinking 접기·per-run hide·진행문 필터 |
| `internal-actions` | 위 컴포넌트들의 클릭 소유자 (MouseRegion 재배선 필요) |
| `misc-tui-autocomplete` | 줄 중간 `/skill:`·`$skill` 자동완성 (stock은 첫 줄만) |
| `misc-model-selector` | 모델 선택기의 프로바이더 그룹핑·Sol 우선·표시 라벨 |
| `misc-thinking-levels` | Shift+Tab 순환이 off/minimal을 건너뛰지 않음 |
| `transcript-cache` | 긴 `/resume` 첫 페인트 전에 전체 메시지를 그림 |
| `core-session-list-page` | `/resume` 목록이 전체 jsonl을 읽고 나서야 뜸 |
| `busy-enter` (`src/`) | 스트리밍 중 Enter가 후속 입력 큐잉이 아니라 steer로 동작 |
| `title-guard` (`src/`) | 스트리밍마다 같은 제목을 재발행해 탭이 깜빡임 |

한글 입력 조립(stdin StringDecoder, A1)과 클립보드 이미지(A3)도 must-port 판정이지만
`features/tui-input`으로 이식 경로가 이미 잡혀 있다. 설치 feature 목록에 `tui-input`이
있으므로 **실제 동작 여부를 먼저 측정**하고 중복 착수하지 않는다.

### B. 장식 — 복구 대상과 유지 제외

사용자가 되찾고 싶다고 지목한 것:

| 항목 | 파일 | 비고 |
| --- | --- | --- |
| statusline (푸터 테마) | `harness/rubato-pi/src/statusline.mjs` | 브랜드 워터마크·짧은 라벨·speed-index |
| rubato-footer | `harness/rubato-pi/src/rubato-footer.mjs` | stock `FooterComponent`를 statusline으로 교체하는 로드 재작성 |
| boot-chrome / splash | `src/boot-chrome.mjs`, `boot-splash.mjs`, `boot-resonance.mjs`, `boot-worker.mjs` | 런처는 splash를 유지하지만 엔진 인계(adoptShellSplash)가 stock에 없음 — 현재 동작 확인 필요 |

유지 제외(복구하지 않음): `interactive-control-surface`, `control-interactive-mode`,
`control-slash-commands`(A16 원격 전용), `boot-*-defer`·`boot-catalog-slim`·`boot-perf`
(부팅 그래프 최적화, 동작 불변), `misc-high-reasoning`, `core-error-format`.

## 별건 — remote-surface 부팅 실패

부팅마다 한 줄 찍히는 그 오류다. 트랜스폼 문제가 아니라 **설치본 경로 해석 버그**다.

- `harness/pi-runtime/features/remote-surface/protocol-loader.mjs:43-54` — 자기 파일
  위치에서 위로 올라가며 `packages/rubato-remote-protocol/src/index.ts`를 찾고, 못 찾으면 throw
- 레포에서 실행하면 feature 파일이 체크아웃 안에 있어 성공한다. 설치본은
  `~/.rubato-pi/stock-engine/rubato-features/remote-surface/`에 있고 그 상위에 체크아웃이
  없다 (`~/.rubato-pi/stock-engine`, `~/.rubato-pi`, `~` 모두 확인 — 없음)
- 결과: 설치된 엔진에서 remote surface는 **항상** 시작에 실패한다. 레포 내 테스트가
  통과한 것은 실행 위치가 달랐기 때문이다
- 회피 경로는 이미 있다: `RUBATO_REMOTE_PROTOCOL` 환경변수 override
  (`protocol-loader.mjs:47-48`)

고칠 방향(택일은 담당 몫): 설치 시 protocol 번들을 `rubato-features/remote-surface/` 안에
동봉하고 로더가 동봉본을 먼저 보게 하거나, 설치 영수증에 체크아웃 루트를 기록해 읽게 한다.
어느 쪽이든 **설치본 경로에서 재현하는 테스트**가 같이 들어가야 한다 — 현재 테스트는 이
실패를 못 잡는다.

## 측정되지 않은 영역 (착수 전 확인할 것)

비-TUI로 분류돼 검토에서 빠진 43개는 "stock에 대응물이 있다"고 확인된 것이 아니라
**분류 대상이 아니었을 뿐**이다. 여기엔 compaction 정책, lane policy, overflow,
empty-recovery, retry/stream watchdog, speculative, session persist/resume budget,
context-notes, tool-surface/descriptions, terminal routing, cursor exec 전반,
provider 계열 misc가 포함된다. 설치 feature 목록(33개)에 `compaction`, `config-reload`,
`service-tier`, `tool-policy`, `context-notes` 등 이름이 겹치는 항목이 있으나 **동등성은
확인되지 않았다**. A/B 착수 전에 이 43개에 대해 "후보 feature로 대체됨 / 대체 없음 /
불필요"를 한 번 판정해야 한다. 누락이 있다면 화면이 아니라 조용한 동작 차이로 나타난다.

## 검증

- 항목별 단위 테스트는 각 feature 디렉터리 관례를 따른다
  (`cd harness/pi-runtime && node --test`)
- 화면 항목은 유닛만으로 증명되지 않는다. PTY 캡처로 실제 부팅 화면을 받고 전후를 비교한다
  (`script -q <out> env TERM=xterm-256color harness/scripts/rubato-pi.sh direct`)
- 부팅 stderr는 0줄이 목표다. 현재는 remote-surface 한 줄이 남는다

## 주의

- `harness/rubato-pi/src/transforms/core-prompt-noise.mjs`와
  `harness/rubato-pi/test/unit/prompt-noise.test.mjs`는 이 조사 시점에 미추적 상태였다.
  다른 세션의 작업물이므로 건드리지 않는다
- 두 엔진은 같은 `agent/auth.json`을 공유한다. 같은 프로필에서 동시 실행하지 않는다
