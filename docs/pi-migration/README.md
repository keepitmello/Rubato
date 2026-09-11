# Pi 어댑터 이관 — 현재 실행 상태

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

## A1 접점

세션-서버가 재사용할 실제 후보 CLI 한 경로의 접점이다. 새 인터페이스가 아니다.

- **생성 진입:** `runRubatoCandidate` (`harness/pi-runtime/features/rubato-components/candidate-main.mjs`). 절대 경로 `RUBATO_CANDIDATE_AGENT_DIR`이 있어야 하고, stock `main()`에 `createRubatoExtensionFactories`를 넘긴다. 세션 파일은 stock이 `PI_CODING_AGENT_SESSION_DIR`=`$RUBATO_CANDIDATE_AGENT_DIR/sessions`에 만든다.
- **런타임 고정:** `buildRubatoCandidate`가 stock Pi 0.85.1 + 선택 feature를 stage한다. `candidate-main`은 import 전에 `PI_PACKAGE_DIR` / `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`을 후보로 덮고, `rubato-pi-stage.json` receipt(`stockVersion` 0.85.1, selected features, payload hash)를 검증한다. 기본 프로필은 쓰지 않는다. 시험은 빈 HOME, `PI_OFFLINE=1`, `--provider fixture --model local-only`.
- **사건 예:** `prompt` RPC 응답 `success:true`는 preflight 수락이지 턴 완료가 아니다. 수락 뒤 `agent_start` → user `message_end` → assistant `message_end` → `agent_end`가 한 턴의 완료다. 모델 주도 tool loop는 tool_call → tool_result → 후속 provider 요청 → 최종 assistant까지 포함한다. 스트리밍 중 `abort` RPC는 현재 턴을 끊고 그 턴의 `agent_end`로 끝난다. 세션 jsonl은 파일 존재만 확인하며, 저장 시점(첫 user append vs 턴 완료)은 이 시험으로 증명하지 않는다. `switch_session`으로 같은 파일을 다시 연다.
- **좁은 시험:** `cd harness/pi-runtime && env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test --test-timeout=90000 test/candidate-cli.test.mjs`

상태: 최신 Rubato 기반에서 stock Pi 기능 모듈과 실제 Rubato bundle을 조립하고 있다.
전체 기능 이관·기본 엔진 전환은 아직 아니다. 네 번째 단위의 진행 기록과,
아래 커밋된 세 번째 단위 검증 결과를 구별한다.

중간 저장: 제품 `3011aafa4` → `c0f6b6f99` → `ead7cb763`,
lab 계획 `1867787` → `39da024` → `ad0f551` (2026-09-08).
사용자 변경 6개는 커밋에서 제외했다.
두 번째 구현 단위인 tool 실행/검색, 입력/abort identity, `/fast` 지속성, 독립 codemode의 JS 경로를
격리 stock SDK에서 검증했다. 당시 전체 runtime suite는 **62/62 pass, fail/skip 0**이었다.
각 구현 담당은 그대로 유지하며, 공통 패키징·조합 검증은 리드가 소유한다.

네 번째 단위를 진행 중이다. media/web 도구의 현재 동작을 보존하기 위해 standalone direct
dependency를 15개로 늘렸으며 Pi 6종은 그대로 0.85.1이다. jsdom 30.0.1 요구 조건에 맞춰
후보의 Node 조건은 `^24.15.0 || >=26.0.0`으로 올렸다. npm audit는 0이며 새 단위 전체 검증은
아직 아니다. 아래 세 번째 단위의 98개 결과/lock hash는 `ead7cb763` 체크포인트에 한정한다.

## builtin 판정

Senpi 등록 46행(`docs/pi-migration/builtin-inventory.json`, 2026-09-11). 등록 진입점 coverage이며 기능 전체 parity가 아니다. 사용자가 직접 치는 슬래시 명령은 제품 코드가 안 부른다고 unused가 되지 않는다. stock 동등 명령 / 후보 feature / 아니면 needed-missing.

| 판정 | 수 | 의미 |
| --- | ---: | --- |
| stock-pi | 1 | `reasoning` → stock `/thinking` (`pi-coding-agent/dist/core/slash-commands.js`) |
| candidate-has | 20 | 후보 feature+테스트. `account`는 A6 `providers/auth-pool` `/account` |
| rubato-disabled | 4 | `claude-sdk-oauth`, `cursor-cli-oauth`, `anthropic-web-search`, `websearch` (`session-defaults.mjs` `DISABLED_BUILTIN_EXTENSIONS`) |
| needed-missing | 16 | stock/후보에 동등 표면 없음. 이번 단위에서 연결하지 않음 |
| unused | 5 | 사용자 슬래시가 아님: `anthropic-bash`, `recommended-models`, `cache-keepalive`, `prompt-url-widget`, `tps` |

needed-missing 런타임(기존 large): `prompt-preset`, `compaction`, `video-in`, `goal`, `config-reload`.
`goal` tracked 근거는 `harness/rubato-pi/src/codemode/index.ts`(goal builtin session_start 카운트). untracked `core-prompt-noise.mjs`는 인용하지 않는다.

needed-missing 사용자 명령: `history-search` `/history`, `diff`, `files`, `help`, `redraws` `/tui`, `model-fallback` `/fallback`, `import-repro` `/ir`, `loop`, `ttsr`, `btw`, `gpt-account`(A6 Codex credential import와 짝, `/gpt-account` 자체는 후보에 없음).

A12: `features/user-commands-agent/` — `/goal` `rubato-goal`, `/loop` `rubato-loop`, `/btw` `rubato-btw`, `/ttsr` `rubato-ttsr` (스트림 품질 규칙 감시·상태), `/fallback` `rubato-model-fallback` (수동 전환, 자동 retry.modelFallback 끔), `/ir` `rubato-import-repro`.

## 네 번째 단위 — CLI 조립과 남은 기능군

- **실제 후보 CLI:** stock main이 만든 canonical ModelRuntime/SettingsManager를 그대로
  factory callback에 넘기는 4-file 접점을 추가했다. SDK 전용 조립에 머물지 않고 실제
  RPC CLI에서 현재 Rubato 도구·7 provider 등록, memory 작성/Git commit/RPC 상태,
  new_session 단일 start, reload 후 도구 보존, JSON stdout을 검증했다.
- **실사용 경로 격리:** 후보는 절대 경로 `RUBATO_CANDIDATE_AGENT_DIR` 없이는 시작하지
  않는다. inherited package/managed-install/profile/session 경로를 후보로 고정하며,
  오염된 환경을 넣어도 기존 sentinel 디렉터리가 바뀌지 않는 실제 child 검사가 통과했다.
  아직 일반 launcher/default 설치로 노출하지 않는다.
- **불완전 설치 차단:** 모든 선언된 patch/addition/bin/package/lock hash를 stock import 전에
  대조하고 필수 factory 접점 4개를 요구한다. staged main을 순정 원본으로 되돌리거나
  receipt에서 hook record를 빼면 plain Pi로 진행하지 않고 종료한다. 두 독립 리뷰 finding을
  수정했고 이 CLI/factory 범위 재리뷰는 READY다. signed supply-chain 검증은 아니다.
- **추가 조립:** webfetch/look_at, loop/apply_patch/tool-pair guard, Cursor native exec를
  catalog/bootstrap에 연결했다. guard는 하나의 묶음이 아닌 기존 실행 순서의 개별 factory다.
  실제 CLI + SDK direct/search 조합은 3/3 통과했다. 이 결과는 후속 imagegen/권한/컨텍스트
  작업까지 포함한 전체 네 번째 단위 green은 아니다.
- **진행 중:** client imagegen, hooks/permissions/bash-timeout, notes-aware context-window,
  실제 provider-bearing child profile, Cursor guarded abort/replay 검증을 같은 담당자가 맡는다.
  nested AGENTS/rules/prompt-preset/todo는 별도 담당 1명이 독립 namespace에서 진행한다.

현재 standalone lock SHA-256은
`5201145de576da141b9ea8d3a388aa91c7b8e3de801fddf4d35780e38e8ae7d3`이다.
직접 의존 15개와 Pi 6종 설치 대조를 통과했고, image provider source 호환을 위해
`openai@6.26.0`을 별도 exact dependency로 사용한다(stock Pi의 내부 SDK 버전은 바꾸지 않는다).
원본 builtin 등록 inventory는 생성 시점의 정적 목록이므로 상태 필드가 모두 pending이다.
실행 완료 범위는 이 문서와 각 기능 문서/actual staged test가 정본이며, 목록 전체 parity로
자동 승격하지 않는다.

## 세 번째 단위 — 2026-09-08 체크포인트

- **Rubato 실제 조립:** 현재 workspace source에서 task/team/member/memory/MCP/worker/LSP
  실행물 7개를 별도 Bun builder로 만들고, stock dependency tree의 공개 exports만 연결한다.
  원본 checkout·global Senpi import fallback은 없다. 현재 component 등록 실패는 필수 기능의
  조용한 누락이 되지 않고 실패로 드러난다. SDK bootstrap은 stock AgentSession을 그대로 쓴다.
- **기능 소비자:** request-run tracker가 input/abort identity를 실제 pending/run/completed
  timeline과 RPC get_state로 전달한다. session catalog는 첫 user turn 저장, 안정적인 page,
  fork/재시작을 검증했다. Extension RPC 요청/이벤트와 memory 상태, /fast footer/RPC를 연결했다.
- **MCP + memory:** 현재 ast-grep/memory 선언을 registry가 수집하며 exposure/lifecycle을
  보존한다. health/expiry/retry와 service-owned output spill cleanup을 연결했다.
  실제 Rubato config의 direct/search를 각각 빈 profile에서 실행해 memory 파일 작성·Git commit·
  RPC headSha 확인까지 통과했다. search 경로는 도구 검색→실제 MCP subprocess 호출→
  단일 write notice를 검증했다. 기존 MCP memory 이름 불일치도 바로잡았다.
- **provider:** stock 4개 + 소유 Cursor/Kiro/Antigravity 3개를 등록한다. 실제 stock SDK에서
  Kiro HTTP, Antigravity OAuth env/SSE/hooks, Cursor HTTP2 Connect/protobuf를 로컬 서버로
  검증했다. 세 route의 abort/EOF 단일 terminal도 통과했다. 실계정 요청은 하지 않았다.
- **terminal/interpreter:** native macOS arm64 PTY에서 six-tool 등록, input/output/screen/resize,
  reload 후 같은 bash_id·shell 변수 유지, monitor/단일 process 종료를 검증했다.
  Python/Ruby/Bun interpreter도 실제 실행했다. Julia는 미설치라 skip이며 성공으로 세지 않는다.
  interactive shell의 별도 process-group descendant 종료 결함은 원래 Senpi에서도 같은
  조건으로 재현됐다. 이관 회귀와 구별해 기록했고 시험 PID는 정리했다.
- **child:** explicit staged unbundled RPC entry와 PI session-dir env를 사용하며 Senpi PATH
  선택을 우회한다. in-process는 부모 canonical ModelRuntime을 주입한다. 실제 기존 runner
  실행/JSONL/stream-start 후 취소/프로세스 종료를 rejecting timeout과 자동 E2E로 확인했다.
- **빌드 검증 보강:** 빌드에 읽힌 source bytes, 모든 bundle/asset/metadata의 hash를 기록한다.
  ready receipt의 schema·선택 lock·필수 payload 누락을 검사하고 bootstrap에서도 모두 재검사한다.
  독립 리뷰가 찾은 RPC replacement 이중 session_start는 네 replacement 분기를 고쳐
  실제 child의 단일 이벤트로 재검증했다. receipt/metadata 누락 검사도 독립 재리뷰 READY다.

현재 실행 증거:

- 빈 HOME·별도 profile·PI_OFFLINE에서 체크포인트 범위 **98 tests: 97 pass, fail 0, Julia skip 1**,
  53.87초. catalog 15개 기능 + 미등록 context-notes 기반 + 공통 build/install tests를 포함한다.
  아직 구현 중인 다음 feature namespace는 이 실행에서 제외했다. 이것은 전체 제품 parity가 아니다.
- MCP 시험 서버가 진행 metadata를 canonical SDK extra에서 읽도록 고쳤다. 진행 알림 검사를
  독립 프로세스 20회 반복해 **20/20** 통과했고 위 최종 조합에서도 통과했다.
- root direct dependency 10개, Pi 6종 0.85.1, registry SRI 271/271.
  현재 lock SHA-256: `73e62bee015fc3c41bb2a862b4c0ffb0c55e163f7f492230f244d23b4ead6970`.
- 원본/worktree 사용자 파일 **12/12 hash 보존**, `git diff --check` 통과.
- source memory unit 4개는 worktree 루트 의존성 부재로 직접 실행하지 못했다. 위 실제 bundle
  direct/search/notice 경로는 통과했지만 모든 기존 unit의 통과를 대신 주장하지 않는다.

context-notes 기반 저장·주입·reload/clone도 actual SDK/RPC에서 통과했지만 `/new-context`
원자적 전환이 미완이라 catalog/bootstrap에는 아직 등록하지 않았다.
이어지는 소유 단위는 context-window/compaction, Cursor native exec/tool pairing,
tool guards/permissions, media/web tools다. 같은 담당자가 새 feature namespace에서 진행한다.
아직 자동 builtin 장부 전체, credential pool/refresh/import, 전역 TUI·resume/remote·부팅,
후보 CLI bootstrap/설치·업데이트·실사용 전환은 끝나지 않았다. 기본 빌드는 계속 Senpi다.

## 기준과 범위

- 사용자 결정(2026-09-08): 기존 작업은 참고만 사용한다. 최신 Rubato + 최신 정식 Pi 위에
  필요한 Senpi 기능과 Rubato 기능을 누락 없이 합치고, Senpi 내부 재패치 결합을 분리한다.
- 제품 기준: `1f6ca5392a554b8b27126e6d016b0ffc00260707`. 착수 때 원격 `rubato/base`와 동일했다.
- 작업 브랜치: `codex/pi-adapter-0851`; 원본 제품 checkout과 별도의 worktree다.
- 원본의 미커밋 파일 6개도 복사해 바이트 동일성을 확인했다.
  [baseline.json](baseline.json)은 그 보존 기준이며 우리 변경이나 커밋 대상으로 간주하지 않는다.
- Pi: `@earendil-works/pi-coding-agent@0.85.1`. npm latest와
  [정식 릴리스](https://github.com/earendil-works/pi/releases/tag/v0.85.1)를 대조했다.
  이번 작업에서는 이 버전을 고정한다. 과거 0.84.2 패치를 그대로 적용하지 않는다.
- `harness/pi-runtime/`은 기존 Bun/Senpi overrides의 영향을 받지 않는 독립 의존 프로젝트다.
  실제 dependency 선택은 여기서 검증한다. 기존 launcher·기본 프로필·세션 데이터는 아직 바꾸지 않는다.

## 소유 경계

| 담당 | 범위 | 상태 문서 |
|---|---|---|
| 리드 | 공통 구조·기준·패키징·builtin 전체 목록·통합·최종 검증 | 이 문서, lab 재계획 정본 |
| pi_runtime_owner | 순정 Pi 배포 경계 조사 이후 독립 codemode source/assets·실행 | `upstream.md`, `codemode.md` |
| tools_owner | 일반 tool 실행, MCP client·tool 검색, PTY 후속 | `tools.md` |
| session_ui_owner | 세션·이벤트·reload·remote·context-notes·입력·TUI 접점 | `session-ui.md` |
| provider_owner | provider/auth/model/fast/cache·stream 기능 경계 | `providers.md` |

네이티브 Codex 서브에이전트 4명(GPT-5.6 Sol ultra)이 각 영역을 계속 맡는다.
설치·패키징 경계에는 독립 리뷰 담당 1명을 추가했다.
사용자가 모델 승인 절차와 소극적인 위임 제한을 해제했다. 같은 영역은 같은 담당자가 수정·재검증한다.
서로의 파일을 덮어쓰지 않으며 공통 API·manifest/build 변경은 리드가 통합한다.

## 구현 원칙과 실제 완료 조건

Pi 하네스와 공개 API를 유지한다. Senpi 유래 기능 코드는 소유 모듈로,
Pi 내부 구조를 알아야 하는 코드는 명시된 연결/패치 경계로 모은다.
모든 호출을 감싸는 새 범용 하네스나 거대한 Senpi 호환 레이어를 만들지 않는다.

각 경로는 현재 진입 → 상태/이벤트 → 소비자 → 결과/오류/취소 → 자원 정리까지
대조한 후 구현한다. 나머지 기능 조사와 독립적인 경로 구현은 병행할 수 있다.
선택된 모든 경로가 완료되기 전에는 후보를 전체 Rubato 대체품으로 노출하지 않는다.
자동 builtin·설정으로 켤 수 있는 기능·동적 import도 목록에 포함하며 미확정은 누락시키지 않는다.

검증은 단위 → 실제 순정 SDK/CLI/RPC → 기능 조합 → 격리 설치/업데이트/기존 세션 복사본 순서다.
provider는 로컬 mock부터 검증한다. 실계정 요청·라이브 전환·push는 별도 작업이다.
테스트 수가 아니라 연결된 기능과 미연결/미확정 기능을 보고한다.

## 두 번째 중간 저장 당시 증거

- **런타임 선택·조립:** stock suite 6개를 실제 Node import graph에서 고른다. alias,
  다른 버전·물리 사본·외부 경로·잘못된 export는 실패한다. 별도 lock과 root dependency,
  선택된 설치 manifest를 대조하고 모든 Pi tarball의 SHA-512 pin을 요구한다.
  `stagePiRuntime`은 새 디렉터리에만 만들며 원본 파일 hash를 확인한 뒤 선택 patch를 합성한다.
  복사 전후의 상대 symlink 경계를 검사하고, 패치 직전에도 원본으로 쓰기가 새지 않는지 확인한다.
  npm `cmd-shim`으로 staged `pi`·`pi.cmd`·`pi.ps1`을 같은 unbundled CLI로 연결한다.
  root direct dependency 5개도 실제 경로·identity·version·lock과 대조한다. 독립 기능은
  `rubato-features/<id>/`에 두고 root dependency를 선택하며, Pi 연결 모듈만 Pi package에 둔다.
  추가 파일의 namespace·중복·덮어쓰기·symlink·hash·mode를 검사하고 receipt에 기록한다.
  receipt의 `fullRubatoParity: false`는 의도적인 상태다.
- **reload 최소 접점:** Pi 0.85.1의 12개 파일에 exact-hash 패치를 선언했다.
  실제 SDK에서 veto·재검사 경쟁 조건·종료 순서, 실제 RPC에서 취소 응답을 검증했다.
  UI 검사는 실제 InteractiveMode 메서드에 대역 UI를 연결한 것이며 렌더링 E2E는 아니다.
- **MCP stdio 기능 모듈:** 실제 subprocess로 initialize, 페이지별 tools/list,
  tool call·진행·에러·abort·시작 실패 rollback·종료를 검증했다.
  순정 SDK의 동적 tool 등록과 같은 runner의 재시작도 검증했다.
  이제 BM25 검색·owner-controlled lazy activation·ownership-aware history 복원도 연결됐다.
  MCP/extension 이중 수집은 한 도구당 한 owner로 정리했다. 설정 discovery·producer/memory
  wiring·MCP health/retry/output guard·provider-native 검색은 아직 남아 있다.
- **일반 도구 실행:** `executeTool`은 stock schema 준비/검사, 호출 전 훅, 활성 wrapped tool,
  결과 훅을 거친다. inactive 활성화는 등록 owner만 결정하며 MCP 전용 우회가 없다.
- **입력·중단 접점:** 같은 text와 서로 다른 image의 queue identity, 입력별 단일
  handled/queued/started/rejected, active/late/gap abort의 단일 terminal event를 실제 SDK
  로컬 stream으로 검증했다. 기존 request-run/memory/remote 소비자 연결은 다음 단위다.
- **codemode:** source와 worker/interpreter/skill/license 99개를 독립 feature로 stage한다.
  실제 SDK bind, persistent JS, inactive tool 실행, detach/peek/stop/Worker·HTTP bridge 정리를
  검증했다. Python/Ruby/Julia/Bun 실행, TUI/image/provider completion은 아직 아니다.
  removed-tool hint는 다음 provider context에 보존되며 최초 TUI 오류 문자열 일치는 남아 있다.
- **`/fast`:** 실제 stock SettingsManager의 모델별 저장과 새 세션 복원, fast-capable 모델
  전환 중 live intent 유지, Codex/xAI/Anthropic 요청 payload를 로컬 대역으로 검증했다.
  footer/lightning/RPC에는 공개 state bridge를 제공하며 실제 소비자 연결은 남아 있다.
- **기능 조합:** catalog의 8개 기능을 한 설치본에 함께 넣고 SDK에서 등록했다.
  `eval → inactive MCP 활성화 → 실제 stdio 호출 → tool hooks`, 검색, 입력 ID를 검증했다.
  veto 때 같은 MCP 도구와 프로세스가 유지되고, 허용된 reload 때 기존 프로세스 종료 후
  새 도구로 호출되며 이전 도구는 실패하는 것을 확인했다. staged 표준 bin도 실행했다.
  catalog는 필요한 선행 hook을 포함해 파일을 조립할 뿐, CLI에서 기능을 자동 등록하지 않는다.
  이 검사는 SDK에 기능을 명시적으로 주입한다. 완성된 Rubato bootstrap/launcher/install 검사는 아니다.
- **provider 연결:** 지원 7개 목록과 등록 전 검증을 분리하고 native factory 출처를
  명시적으로 주입할 수 있게 한다. 기본 loader는 아직 기존 Senpi다. 실제 순정 factory 4개와
  Cursor/Kiro/Antigravity 대역을 조합한 검사는 각 실제 provider의 이식 완료가 아니다.
- **누락 탐지:** 현재 Senpi의 builtin 41개, codemode, global defaults 4개를 정적으로 수집했다.
  46개 등록 항목에는 Rubato가 이미 비활성화하는 4개도 남긴다. 이 장부는 등록 진입점
  coverage이며 전체 기능 또는 재귀 의존 coverage가 아니다. 미완료 항목은 계속 pending이다.
- 원본과 새 worktree의 사용자 파일 6개는 baseline hash와 계속 일치한다.
  실사용 엔진·프로필·세션은 변경하지 않았다. 전체 parity, 유료 provider, 렌더링 TUI,
  제품 설치/업데이트 전환은 아직 검증하지 않았다.

독립 리뷰는 lock ignore·install 대조·nested integrity 누락, `.bin` 복사 오류,
Windows shim의 patch 우회, symlink 재배치 시 원본으로 쓰기가 새는 문제를 찾았다.
각 문제를 수정했고 재배치 공격 fixture에서 원본 보존도 검증했다.
최종 판정은 **검토한 런타임/패키징 범위 READY**다. 전체 제품의 승인이나 전환 승인이 아니다.
두 번째 단위에서는 direct dependency 누락, umask와 receipt 불일치, Codex 모델 전환 시
`/fast` live intent 소실도 수정했다. 패키징 재리뷰와 tool/service-tier 독립 리뷰 모두
잔여 finding 없이 READY다. MCP 검색 중복은 리드의 전체 조합 검사에서 발견·수정했다.

2026-09-08 두 번째 단위 실행 기록:

- 빈 HOME·별도 Pi profile·`PI_OFFLINE=1`에서 standalone 전체 **62/62 pass, fail/skip 0**, 25.16초.
  실제 stock SDK/CLI/RPC와 subprocess/Worker를 사용했고 provider stream은 로컬 대역이다.
- 독립 패키징 재검증: stage/installed **20/20 pass**. root direct dependency 누락/alias/다른 버전/
  외부 fallback, restrictive umask를 재현해 실패 또는 정확한 mode 보존을 확인했다.
- 별도 root 재설치: **265 packages**, Pi 6종과 direct dependency 5종 확인, registry tarball
  265개 SHA-512 누락 0, 설치 후 source와 lock hash 동일:
  `dc1858038b6612aefa43b6c980acb8fb72c7d218702caa18f6a0b4195a41cc7f`.
- 사용자 보호 파일은 원본/작업본 합계 **12/12 hash 동일**. 기본 엔진·프로필·세션 변경과 push 없음.

첫 중간 저장 `3011aafa4` 전 실행 기록(위 결과와 구별):

- standalone 전체: **34/34 pass, fail/skip 0** — SDK/CLI/RPC, MCP/reload, 실제 staged 조합 포함.
- provider focused: **56/56 pass, fail/skip 0** — Bun direct/overlay 50 + Node admission/IDs 6.
  stock native 4개만 실제 구현을 사용했고 나머지 3개 route는 주입 대역이다.
- 독립 재검증: resolver/stage 20 + installed runtime 3 + 실제 조합 1 통과(위 34와 중복).
- 새 root·빈 cache의 `npm ci`: 260 packages 설치, Pi suite 6/6=0.85.1,
  registry tarball 260개 integrity 누락 0. lock SHA-256 전후 동일:
  `415010d7198091f391671e12cde4b71ecc5e6d62abd32f9e8d2003655d1c329b`.
- `git diff --check` 통과. 원본/작업본 사용자 파일 6개 hash 보존. 위 중간 커밋 전에 실행한 기록이며 push는 없다.
- Node 26.5.0/Bun 1.4.0, macOS arm64에서 실행했다. Windows shim 3종의 생성·대상 검사는 했지만
  Windows `.cmd`/PowerShell 실제 실행은 아직 하지 않았다.

## 재현과 이어갈 순서

Node 24.15 LTS 또는 26 이상에서 standalone 프로젝트 안에서 실행한다. media의 jsdom과 codemode의 Babel 8 요구 조건을 함께 따른다.
기존 루트 Bun 설치로 대체하지 않는다.

```sh
cd harness/pi-runtime
npm ci --workspaces=false --ignore-scripts
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE npm test --workspaces=false
```

테스트는 비용 드는 provider 호출 없이 격리된 임시 세션·MCP 서버를 사용한다.
lock SRI는 npm이 내려받는 tarball을 검증하며, 이미 설치된 모든 임의 파일의 무변조까지
보증하지는 않는다. 패치 대상은 별도로 전체 파일의 pristine hash를 검사한다.
Pi 배포본의 shrinkwrap 때문에 `npm install`은 nested Pi 5개의 보강한 integrity를 제거할 수 있다.
의존성을 바꾼 뒤 exact registry integrity를 다시 대조·보강해야 한다. 해당 pin이 없으면
installed-runtime 테스트와 stage가 실패한다. 평소 재현 설치는 보강한 lock으로 `npm ci`를 쓴다.

두 번째 중간 저장 때 정한 순서는 아래와 같다. 현재 완료/진행 상태는 문서 상단을 따른다.

1. **Rubato 소비자 연결:** input/abort record를 기존 request-run tracker에 연결한다.
   MCP producer 설정과 tool surface 정책, service-tier의 footer/RPC state 소비자를 조립한다.
2. **실제 provider:** Cursor/Kiro/Antigravity를 대역 없이 stock runtime에 등록하고,
   pool/account rotation·request/stream 차이를 로컬 서버로 검증한다.
3. **추가 interpreter·PTY:** Python/Ruby/Julia/Bun의 persistence/취소/종료를 실제 실행한다.
   별도 PTY/native source·license·OS/arch 산출물을 확보해 terminal family를 연결한다.
4. **Rubato 조립:** task/team/memory·child RPC·remote/context-notes·부팅/입력/TUI의 현재 기능을
   각각 연결한 뒤 조합 시나리오와 기존 세션 복사본을 검증한다. 설치/업데이트와 기본 엔진 전환은 마지막이다.

이 문서의 증거는 현재 실행에 한정한다. 기존 120개 테스트 로그는 이번 0.85.1 검증이 아니다.
