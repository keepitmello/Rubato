# Pi 어댑터 이관 — 현재 실행 상태

상태: 최신 Rubato 기반에서 조사와 좁은 구현을 병행한다. 전체 기능 이관·기본 엔진 전환은 아직 아니다.

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
| pi_runtime_owner | 순정 Pi 배포/SDK/CLI/RPC 경로와 명시적 runtime resolver | `upstream.md` |
| tools_owner | eval/codemode/PTY, MCP client·tool 검색의 전체 실행·종료 경로 | `tools.md` |
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

## 현재 증거와 다음 작업

- **런타임 선택·조립:** stock suite 6개를 실제 Node import graph에서 고른다. alias,
  다른 버전·물리 사본·외부 경로·잘못된 export는 실패한다. 별도 lock과 root dependency,
  선택된 설치 manifest를 대조하고 모든 Pi tarball의 SHA-512 pin을 요구한다.
  `stagePiRuntime`은 새 디렉터리에만 만들며 원본 파일 hash를 확인한 뒤 선택 patch를 합성한다.
  복사 전후의 상대 symlink 경계를 검사하고, 패치 직전에도 원본으로 쓰기가 새지 않는지 확인한다.
  npm `cmd-shim`으로 staged `pi`·`pi.cmd`·`pi.ps1`을 같은 unbundled CLI로 연결한다.
  receipt의 `fullRubatoParity: false`는 의도적인 상태다.
- **reload 최소 접점:** Pi 0.85.1의 12개 파일에 exact-hash 패치를 선언했다.
  실제 SDK에서 veto·재검사 경쟁 조건·종료 순서, 실제 RPC에서 취소 응답을 검증했다.
  UI 검사는 실제 InteractiveMode 메서드에 대역 UI를 연결한 것이며 렌더링 E2E는 아니다.
- **MCP stdio 기능 모듈:** 실제 subprocess로 initialize, 페이지별 tools/list,
  tool call·진행·에러·abort·시작 실패 rollback·종료를 검증했다.
  순정 SDK의 동적 tool 등록과 같은 runner의 재시작도 검증했다.
  아직 직접 등록 경로이며 lazy 검색·eval·설정 discovery·memory 전체 이식은 아니다.
- **기능 조합:** 실제 stager로 만든 Pi에 reload guard와 MCP extension을 함께 등록했다.
  veto 때 같은 MCP 도구와 프로세스가 유지되고, 허용된 reload 때 기존 프로세스 종료 후
  새 도구로 호출되며 이전 도구는 실패하는 것을 확인했다. staged 표준 bin도 실행했다.
  이 검사는 SDK에 기능을 명시적으로 주입한다. 완성된 Rubato launcher/install 검사는 아니다.
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

2026-09-08 최종 실행 기록:

- standalone 전체: **34/34 pass, fail/skip 0** — SDK/CLI/RPC, MCP/reload, 실제 staged 조합 포함.
- provider focused: **56/56 pass, fail/skip 0** — Bun direct/overlay 50 + Node admission/IDs 6.
  stock native 4개만 실제 구현을 사용했고 나머지 3개 route는 주입 대역이다.
- 독립 재검증: resolver/stage 20 + installed runtime 3 + 실제 조합 1 통과(위 34와 중복).
- 새 root·빈 cache의 `npm ci`: 260 packages 설치, Pi suite 6/6=0.85.1,
  registry tarball 260개 integrity 누락 0. lock SHA-256 전후 동일:
  `415010d7198091f391671e12cde4b71ecc5e6d62abd32f9e8d2003655d1c329b`.
- `git diff --check` 통과. 원본/작업본 사용자 파일 6개 hash 보존. commit/push 없음.
- Node 26.5.0/Bun 1.4.0, macOS arm64에서 실행했다. Windows shim 3종의 생성·대상 검사는 했지만
  Windows `.cmd`/PowerShell 실제 실행은 아직 하지 않았다.

## 재현과 이어갈 순서

Node 24 이상에서 standalone 프로젝트 안에서 실행한다. 기존 루트 Bun 설치로 대체하지 않는다.

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

다음 구현 단위는 아래 순서다. 각 상세 계약은 담당 문서를 따른다.

1. **tool 실행 접점 + 검색:** 기존 middleware·활성화·tool-call/result·취소 의미를 보존하는
   `executeTool` 접점을 먼저 연결한다. MCP는 direct-only 경로에서 tool_search·lazy 노출로 확장한다.
2. **세션 identity와 실제 provider 병렬 진행:** 입력 ID/disposition과 gap-only abort를 먼저
   연결해 request-run/memory/remote가 같은 입력과 종료를 보도록 한다. 동시에 Cursor/Kiro/
   Antigravity를 대역 없이 stock runtime에 등록하고 `/fast`·pool·request 차이를 연결한다.
3. **eval/codemode:** 위 tool 실행 접점 뒤 kernel/PTY/native 자원까지 연결한다.
   Senpi 패키지를 runtime fallback으로 요구하지 않는 selected closure를 소유한다.
4. **Rubato 조립:** task/team/memory·child RPC·remote/context-notes·부팅/입력/TUI의 현재 기능을
   각각 연결한 뒤 조합 시나리오와 기존 세션 복사본을 검증한다. 설치/업데이트와 기본 엔진 전환은 마지막이다.

이 문서의 증거는 현재 실행에 한정한다. 기존 120개 테스트 로그는 이번 0.85.1 검증이 아니다.
