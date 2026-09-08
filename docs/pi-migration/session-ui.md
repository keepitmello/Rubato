# 세션·제어·TUI 이관 계약

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

상태: `@earendil-works/pi-coding-agent@0.85.1` 위에서 reload, 입력 identity/disposition,
gap-only abort provenance, request-run ledger, 첫 사용자 입력 보존과 SDK session catalog paging,
context-notes의 저장·주입·reload·session copy 기반 경로를 구현·검증했다. 나머지는 현재 Rubato와
Senpi의 사용자 기능을 보존하기 위한 소스 기반 구현 경계다.
과거 cutover와 기존 `harness/rubato-pi/src/transforms/**`는 행동을 확인하는 참고 자료이며,
새 런타임에 그대로 적용하거나 Senpi의 `AgentSession`/`InteractiveMode` 전체를 복사하지 않는다.

## 기준과 층 경계

이 문서에서 `stock:`은 독립 설치한 Pi 0.85.1의
`node_modules/@earendil-works/pi-coding-agent/`, `senpi:`는 현재 제품 설치본
`rubato/node_modules/@code-yeongyu/senpi/`, `repo:`는 이 worktree를 뜻한다.
라인 번호는 조사 시점의 배포 JS/d.ts와 현재 제품 소스 기준이다.

구현은 세 층으로 나눈다.

1. **Senpi 기능 모듈**은 입력 수명주기, abort 출처, 세션 목록 같은 재사용 가능한 상태 기계와
   타입을 소유한다. 특정 Pi 배포 파일의 레이아웃을 알면 안 된다.
2. **Pi 어댑터**는 공개 extension/SDK API로 표현할 수 없는 지점만 exact-version,
   exact-hash build-time patch로 연다. anchor가 없거나 둘 이상이면 빌드가 실패해야 한다.
3. **Rubato 어댑터**는 task 정책, remote protocol, context-notes 저장소, TUI 문구·설정 같은
   제품 의미를 소유한다. `@rubato/senpi-task`는 계속 Rubato 소유 패키지다.

완료 조건은 각 사용자 입력이 `진입 → 상태/이벤트 → 소비자 → 결과/취소 → 정리`까지
끊기지 않고, 기존 세션과 원격 표시가 같은 의미를 갖는 것이다. 단지 타입이 컴파일되거나
기존 transform의 anchor가 맞는 것은 기능 완료 증거가 아니다.

## 기능별 계약

| 기능·중요도 | 실제 진입 → 상태/이벤트 → 소비자 | 정리와 불변조건 | Pi 0.85.1의 표면/차이 | 목적지와 필요한 접점 |
|---|---|---|---|---|
| 입력 disposition·대기열 identity — **필수, 구현됨** | TUI/RPC/extension의 `AgentSession.prompt()` → 상관 가능한 `input{inputId,text,images,source,streamingBehavior}` → 차단·변환·queue/start 결정 → 정확히 한 `input_disposition{inputId,handled\|queued\|started\|rejected}`. goal direct-input과 Rubato memory nudge가 이를 소비한다 (`senpi:dist/core/extensions/types.d.ts:958-990`, `senpi:dist/core/agent-session.js:2659-2717`, `repo:packages/rubato-runtime/src/components/memory/nudge-wiring.ts:89-109`). | 같은 텍스트·이미지가 연속 제출돼도 ID와 실제 user-message object로 구분한다. admission 실패는 `rejected`, 소유한 input은 `handled`, provider 진입은 `started`, 실제 queue 진입은 `queued`다. disposition 상태를 먼저 닫아 후속 callback 오류에도 두 번째 결과를 내지 않는다. | 공개 `input`에는 ID가 없고 disposition 이벤트도 없다 (`stock:dist/core/extensions/types.d.ts:654-677`). queue 소비 시 첫 번째 같은 **문자열**을 찾아 제거한다 (`stock:dist/core/agent-session.js:360-381`), 따라서 중복 텍스트 identity를 보장하지 않는다. | 독립 `input-lifecycle` 상태 모듈과 exact-hash Pi patch가 prompt/runner/type 및 queue object identity를 연결한다. Rubato memory nudge와 request-run tracker는 기존 이벤트/record shape를 그대로 소비한다. |
| request-run 추적 — **필수, 구현됨** | 생성된 실제 user-message object에 input record를 결속 → `message_*`/`tool_execution_*` → `agent_settled` 또는 사용자 중단 → remote timeline/request-run/pending-input snapshot (`repo:harness/rubato-pi/src/transforms/request-run-tracker.mjs:1-3,77-197,280-389`; protocol `repo:packages/rubato-remote-protocol/src/types.ts:74-95`). | WeakMap 결속으로 메시지와 별도 장부가 어긋나지 않아야 한다. queue clear는 ID 목록을 반환하고, run은 `completed\|failed\|interrupted` 중 하나로 한 번만 terminalize한다. compaction/retry의 중간 `agent_end`는 같은 run을 성급히 닫지 않는다. | `message_*`, tool execution, `agent_settled`는 이미 공개 이벤트다 (`stock:dist/core/extensions/types.d.ts:559-562,591-626`; `stock:dist/core/agent-session.js:347-355`). 부족했던 안정적인 입력 identity와 gap abort는 앞의 두 기능이 제공한다. | 현재 Rubato의 `request-run-tracker.mjs`와 `assistant-phase.mjs`를 additive feature 파일로 그대로 재사용한다. 좁은 Pi patch는 AgentSession record/event/terminal/API와 RPC `get_state.requestTimeline`만 잇고 전체 클래스를 이식하지 않는다. |
| gap-only abort provenance — **필수, 구현됨** | user/system/provider abort 진입 → 열린 agent-end 경계에 출처를 보관 → `agent_end{aborted,willRetry,abortSource}` 또는 agent-end가 없는 retry backoff/compaction/queued gap에서만 `session_abort` → goal/loop/ttsr/context-notes/memory가 소비 (`senpi:dist/core/agent-abort-provenance.js:1-56`, `senpi:dist/core/agent-session.js:3531-3549`). | 한 abort에 `agent_end(abort)`와 `session_abort`를 둘 다 내보내지 않는다. extension handler가 await 중인 late user abort도 같은 event object에 합류한다. user/system/provider abort는 다음 queue/retry continuation을 막고, gap claim은 concurrent abort에서도 한 번만 terminalize한다. | stock `AgentEndEvent`는 messages만 갖고 (`stock:dist/core/extensions/types.d.ts:554-562`), `abort()`는 controller/agent를 중단하고 idle만 기다리며 별도 이벤트가 없다 (`stock:dist/core/agent-session.js:1222-1228`). | 독립 `abort-provenance` 상태 모듈 + AgentSession event/post-run/abort/type exact-hash patch다. AgentSession subscriber를 쓰는 unbundled RPC는 enriched event를 그대로 전달하므로 별도 RPC patch가 필요 없다. |
| reload veto·UI·RPC — **필수, 구현됨** | `/reload`, extension context 또는 RPC `reload` → host의 선택적 `checkReloadVeto()` → 권위 있는 `session_before_reload` 재검사 → Rubato task guard → veto면 이유 반환, 허용이면 `session_shutdown{reason:"reload"}` 후 runner/settings/resource 재구축. guard는 resident 중 `status === "running"`만 막는다 (`repo:packages/rubato-runtime/src/components/task/reload-guard.ts:5-45`). | precheck 뒤 task가 시작되는 race 때문에 `AgentSession.reload()` 내부 gate가 최종 권위다. veto 전에는 editor, extension UI, runner, child/MCP 자원을 건드리지 않는다. 허용 시 shutdown은 정확히 한 번이며 새 runner에 rebind한다. terminal resident는 막지 않는다. | stock reload는 곧바로 shutdown/invalidate한다 (`stock:dist/core/agent-session.js:2217-2240`), TUI도 먼저 `resetExtensionUI()`한다 (`stock:dist/modes/interactive/interactive-mode.js:4978-4987`). 공개 veto/RPC reload가 없어 아래 좁은 patch를 추가했다. | Senpi 계약은 cancellable event/result뿐이고, Pi 어댑터는 runner/session/TUI/RPC/type 접점을 연다. Rubato guard와 task shutdown 정책은 Rubato에 남긴다. |
| `/resume`·목록 paging·첫 입력 보존·fork — **필수, SDK 구현됨; picker wiring 남음** | `/resume` → mtime newest-first 파일 discovery → 한 page JSONL parse → picker의 load-more/search → 선택한 session switch/rebind. 첫 user message가 기록되는 즉시 JSONL을 생성한다. fork는 선택 entry → cancellable `session_before_fork` → 새 session/rebind다 (`repo:harness/rubato-pi/src/transforms/core-session-list-page.mjs:27-124,170-232,507-568`; persist 이유 `repo:harness/rubato-pi/src/transforms/core-session-persist.mjs:3-10`). | 빈 TUI 실행만으로 파일을 만들지 않지만, assistant가 오기 전 crash/provider error에도 첫 입력 세션은 다시 열려야 한다. paging은 newest-first 안정 순서, 중복/누락 없는 cursor, scope별 total/hasMore를 보존한다. switch/fork 시 이전 extension/UI 자원을 정리하고 새 세션에만 bind한다. 일반 page는 선택한 파일만 full-parse하고, message text index가 없는 검색은 해당 scope를 full-scan한다. | stock `list/listAll`은 모든 JSONL을 읽는다 (`stock:dist/core/session-manager.js:1311-1363`)이고 첫 assistant 전에는 flush하지 않는다 (`:739-767`). 반면 fork와 cancellable `session_before_fork`는 native runtime/RPC에 있으므로 재사용한다 (`stock:dist/core/agent-session-runtime.js:92-96,174`; `stock:dist/modes/rpc/rpc-mode.js:484-495`). 0.85.1 SDK에는 과거 `assertModelUsable` resume gate가 없어 옛 `core-session-resume-budget` patch는 이식 대상이 아니다. | additive `session-catalog` 모듈과 SessionManager runtime/type patch가 first-user flush 및 `listPage/listAllPage`를 제공한다. native open/fork는 실제 first-user-only 파일로 검증했다. Rubato page size와 TUI picker load-more 연결은 아직 남았다. |
| context-notes·compaction 소유권 — **저장·주입·reload/copy 구현됨; `/new-context` commit 남음** | session start/tree/model → mode 선택·store/controller → `before_agent_start` admission → `context` window 제공 → `turn_end` checkpoint → `/new-context` commit. extension 층은 session/agent abort와 shutdown 때 pending/controller를 정리한다 (`repo:harness/rubato-pi/src/extensions/context-notes.mjs:38-101,102-173`). | notes mode에서는 provider에 전달한 window와 저장/commit한 window가 같아야 한다. 실패한 초기화나 전이 commit은 provider 요청을 막는다. manual/automatic/speculative/idle/pruning/server compaction 어느 lane도 notes 소유권을 우회하면 안 되며, no-prune tool-result repair를 유지한다. | public `session_before_compact`, context, turn, tree, model events로 저장·주입·native reload/fork는 연결했다. stock 0.85.1 `ExtensionContext`에는 `agentDir`, `applyCompaction`, `getMessageRevision`이 없다. `agentDir`은 adapter가 stock `getAgentDir()`를 명시 주입한다. stock manual/automatic compaction은 공개 veto로 막지만 `/new-context` 원자적 commit은 후자의 두 접점 없이는 실행되지 않는다. 현재 구현도 extension event 밖의 Senpi-specific compaction lane을 별도 내부 접점으로 다룬다 (`repo:harness/rubato-pi/src/extensions/context-notes.mjs:167-168`; `repo:harness/rubato-pi/src/transforms/core-context-notes.mjs:27-37,53-97`). | 현재 Rubato의 context-notes extension/controller/store/tools 12-file closure를 additive feature로 재사용하고 stock TypeBox/getAgentDir adapter만 둔다. core patch는 아직 0개다. 다음 slice는 revision-checked `applyCompaction` seam과 실제 next-turn/no-prune/server-compaction 결합이며, 그 전에는 전체 context-notes parity라고 하지 않는다. |
| remote interactive control·UI — **필수** | hub `requestId/expectedRevision/action` → 직렬화·TTL dedup → TUI에 bind된 control (`submit/steer/followUp/abort/compact/navigate/fork/new/reload/rename/model/thinking/bash/UI response/queue clear/conversation page`) → revisioned snapshot/event. blocking UI는 request → response 또는 abort/dismiss다 (`repo:harness/rubato-pi/src/interactive-control-surface.mjs:9-129`; `repo:harness/rubato-pi/src/extensions/remote-surface.mjs:170-194`). | 같은 request ID는 한 번만 실행하고 stale revision은 거절한다. UI promise는 response/abort/session replacement 중 하나로 한 번만 settle하며 listener와 pending map을 지운다. in-process new/resume/fork/reload는 TUI/zmx를 살리고 실제 `quit`만 process exit로 보낸다 (`repo:harness/rubato-pi/src/extensions/remote-surface.mjs:51-55`). | stock headless RPC에는 `extension_ui_request/response`와 abort/timeout cleanup이 있다 (`stock:dist/modes/rpc/rpc-mode.js:40-191,618-625`). 하지만 실행 중인 local TUI를 extension에서 제어하는 `get/setInteractiveControl` 공개 API는 없다. RPC UI shape은 재사용할 수 있어도 TUI host bridge는 별도 접점이 필요하다. | Senpi `interactive-control` interface + Pi TUI host adapter. Rubato remote adapter가 protocol/dedup/revision/projection을 계속 소유한다. |
| fullscreen — **native 재사용, 설정 보존 필수** | setting/command → renderer mode switch → layout root·focus·component state 보존 → exit 시 transcript/preserve-screen 정책 (`stock:dist/modes/interactive/interactive-mode.js:310-326,531-633`). | mode 전환 중 editor와 active dialog를 잃지 않고 stop 때 terminal screen 정책을 지킨다. | 0.85.1이 regular/fullscreen, scrollbar, copy-on-select, exit output을 native로 제공한다. 별도 core patch 근거가 없다. | Pi native 사용 + Rubato 설정/default adapter. 문구, border, spinner, 기본 스타일은 cosmetic이다. |
| paste·이미지 attachment — **무손실 필수** | bracketed/clipboard paste → large-paste registry 또는 image attachment marker → editor 교체/submit/queue → 실제 text/images. current Senpi는 editor 간 registry/draft/attachment state를 이전하고 죽은 marker를 제거한다 (`senpi:dist/modes/interactive/editor-paste-transfer.js:1-57`; Rubato collapsed paste repair `repo:harness/rubato-pi/src/paste-expand.mjs:1-94`). | marker가 보이는데 payload가 없거나, queue/새 editor 전환에서 image가 조용히 사라지면 안 된다. submit 직전에 collapsed text를 복원하고, attachment는 undo/queue/editor replacement에도 단일 소유자를 유지한다. 지원 불가·권한·drop 실패는 사용자에게 상태를 돌려준다. | stock은 text paste와 clipboard image를 지원하지만 image를 임시 파일 경로로 editor에 넣고 clipboard 실패를 조용히 무시한다 (`stock:dist/modes/interactive/interactive-mode.js:1919,2312-2355`). current 제품의 in-memory attachment와 명시적 실패 의미와 같지 않다. | Senpi `editor-transfer`/attachment 기능 모듈 + editor replacement/submit/queue의 좁은 Pi adapter. Rubato는 표시와 collapsed-paste 정책을 소유한다. |
| Unicode·mouse selection — **동작 parity 필수, gap 미확정** | 키/IME/paste/mouse 좌표 → grapheme·display-column cursor/selection → copy/delete/typing/clear. Rubato mouse selection은 grapheme segment와 `visibleWidth`/`sliceByColumn`을 사용한다 (`repo:harness/rubato-pi/src/editor-mouse.mjs:85-92`). | 한국어 조합, combining mark, emoji ZWJ, wide char에서 cursor/selection이 code unit 중간을 자르지 않는다. 이동/submit/새 입력은 현재 selection을 규칙대로 해제하며 copy 실패도 표시한다. | 최신 pi-tui도 grapheme segmentation과 Unicode width 기반 editor를 제공하므로 core gap이라고 단정할 근거는 없다. Rubato의 mouse selection은 별도 제품 기능이므로 실제 parity test 전에는 native로 대체했다고 말할 수 없다. | native pi-tui를 기준으로 component-level parity를 먼저 측정한다. 실패한 동작만 Rubato TUI feature + 최소 pi-tui hook으로 둔다. |
| tmux·selector cancellation — **환경 호환/누수 방지 필수** | startup capability probe → 한 번의 안내; local/remote selector → result 또는 abort/dismiss → listener/component dispose. | tmux query는 bounded/best-effort다. inline image를 약속한 환경은 tmux version/passthrough도 확인한다. selector는 늦은 response가 다음 UI를 완료시키지 못하게 token/request ID를 검증한다. | stock은 `extended-keys`와 `extended-keys-format`을 검사한다 (`stock:dist/modes/interactive/interactive-mode.js:783-902`)이고 local extension selector의 AbortSignal/listener dispose가 있다 (`:1953-2036`). current Senpi는 tmux >=3.3, Kitty/allow-passthrough/focus-events까지 진단한다 (`senpi:dist/modes/interactive/tmux-setup.js:1-57`). remote TUI response lifecycle은 stock에 없다. | keyboard/local selector는 native 재사용. Senpi capability diagnostic과 remote UI lifecycle adapter만 추가한다. 경고 문구·묶는 순서는 cosmetic이다. |

## 구현된 reload 경계

`repo:harness/pi-runtime/features/reload/patches.mjs`는 stager가 소비하는 다음 형식의
12개 immutable patch를 export한다.

```js
export const patches = [{ id, packageName, version, path, preimageSha256, apply(source) }]
```

모두 package `@earendil-works/pi-coding-agent`, version `0.85.1`과 pristine file SHA-256을
고정한다. `apply()`는 anchor가 없거나 중복되면 실패하고 재적용도 실패한다. 대상은:

- extension event/result와 runner runtime/type: `dist/core/extensions/{types.d.ts,runner.js,runner.d.ts,index.d.ts}`
- authoritative session gate: `dist/core/agent-session.{js,d.ts}`
- destructive UI 변경 전 precheck와 내부 race 결과 처리:
  `dist/modes/interactive/interactive-mode.js`
- unbundled RPC command/response/client runtime/type:
  `dist/modes/rpc/{rpc-mode.js,rpc-types.d.ts,rpc-client.js,rpc-client.d.ts}`
- package public type export: `dist/index.d.ts`

이 patch는 runtime global hook이 아니며 bundled `dist/bundle/**`를 수정하지 않는다.
따라서 staged Rubato CLI/RPC는 runtime resolver의 `patchableCliEntry`/`patchableRpcEntry`를
명시적으로 실행해야 한다. 실제 veto 정책은 patch에 넣지 않고 기존
`evaluateReloadVeto()`/`wireReloadGuard()`를 extension으로 등록한다.

검증 `repo:harness/pi-runtime/features/reload/reload.test.mjs`는 standalone resolver가 고른
현재 `codingAgentDir`를 기본 pristine 입력으로 쓰며 `PI_RELOAD_TEST_PACKAGE` override만
허용한다. package를 private temp에 복사하고 nested `node_modules`를 symlink한 뒤 공유 fixture는
수정하지 않는다. 실제 SDK에서 다음을 확인한다.

- veto와 precheck 이후 race veto가 runner identity와 child shutdown count를 그대로 유지한다.
- 허용한 reload만 runner를 교체하고 `session_shutdown{reason:"reload"}`를 한 번 낸다.
- 실제 `InteractiveMode.handleReloadCommand()`에서 veto가 editor/extension UI를 건드리지 않는다.
- 실제 unbundled RPC child가 `check_reload_veto`와 `reload` 모두 reason이 포함된 취소 응답을 낸다.
- 모든 patch의 pristine hash, anchor drift/reapply 거부, patched JS syntax가 맞는다.

이 검사는 local dummy model(`127.0.0.1:9`, 호출되지 않음), in-memory session/private temp,
`NODE_OPTIONS` 제거로 실행한다. provider 비용이나 HOME profile을 쓰지 않는다.

## 구현된 입력·abort 경계

`repo:harness/pi-runtime/features/input-lifecycle/`는 상태 모듈 한 개와 pristine hash에 고정된
6개 patch를 제공한다. 상태 모듈은 세션 순번 ID, 아직 disposition이 없는 input, 실제
user-message object의 WeakMap record, queue pending ownership만 가진다. Pi patch 대상은
`dist/core/agent-session.js`, extension runner runtime/type, extension/public type export다.
`AgentSession.prompt()`가 input handler를 호출하기 직전에 ID를 만들고, handled/queued/started/rejected
중 하나로 상태를 먼저 닫은 뒤 event를 보낸다. queue에는 생성한 user-message object 자체를 결속해
동일 문자열과 서로 다른 image가 섞여도 steer/followUp 제거가 문자열 추측에 의존하지 않는다.

`repo:harness/pi-runtime/features/abort-provenance/`도 상태 모듈 한 개와 5개 patch만 제공한다.
상태 모듈은 current abort source, 열려 있거나 settle 중인 agent-end event, continuation stop,
cleared-queue 표식, gap terminal claim을 소유한다. Pi patch 대상은 `dist/core/agent-session.{js,d.ts}`와
extension/public type export다. active run의 user/system abort와 provider가 표시한 abort는 enriched
`agent_end` 하나로 끝난다. retry sleep, compaction controller, queued/just-cleared input처럼 새
agent-end가 생기지 않는 구간의 user abort만 `session_abort`를 낸다. manual compact의 내부 abort는
`system`으로 분류한다.

두 기능은 다음 공통 feature manifest를 export한다. owned state 파일은 stock 파일을 덮어쓰지 않고
stager의 additive `files` 계약으로 package 안에 복사된다.

```js
export const patches = [{ id, packageName, version, path, preimageSha256, apply(source) }]
export const files = [{ packageName, version, path, sourcePath }]
```

실제 검증은 `input-lifecycle.test.mjs`와 `abort-provenance.test.mjs`가 resolver의 현재 standalone
`codingAgentDir`를 기본값으로 사용해 private temp package를 만든 뒤 Pi SDK를 import한다. local
`AssistantMessageEventStream`으로 provider를 대체해 다음을 실행했다.

- input interceptor handled, model admission rejected, 실제 fake stream started, streaming queue를 모두
  통과하고 각 `inputId`에 disposition이 정확히 한 번인지 확인했다.
- 같은 `duplicate` text에 서로 다른 image를 붙여 followUp 뒤 steer 순으로 넣고, Pi의 steer 우선
  소비가 image/message identity와 각 input ID를 보존하는지 확인했다.
- active user/system abort, provider abort, extension `agent_end` handler가 대기 중인 late user join에서
  extension과 AgentSession subscriber가 동일한 enriched event object를 받는지 확인했다.
- 실제 retry backoff를 local 429 error로 열어 취소했고, compaction controller gap과 cleared queue gap,
  concurrent abort에서 `session_abort`가 한 번만 발생하는지 확인했다.

## 구현된 request-run 경계

`repo:harness/pi-runtime/features/request-run/`은 현재 Rubato가 소유한
`request-run-tracker.mjs`와 `assistant-phase.mjs`를 새 package 내부 feature 경로로 복사하고,
Pi 0.85.1의 `AgentSession` runtime/type 및 unbundled RPC runtime/type 네 파일만 exact-hash patch한다.
이 patch는 `input-lifecycle`과 `abort-provenance` 뒤에 적용되어야 한다.

AgentSession은 실제 input record를 tracker의 WeakMap에 붙이고 queue record를 먼저 갱신한 뒤
`queue_update.pendingInputs`를 낸다. 모든 agent event는 extension/TUI/RPC보다 먼저 tracker에 들어가며,
정상 settle은 `completed` 또는 unrecovered provider error의 `failed`, enriched abort나 gap abort는
`interrupted`로 한 번만 끝난다. `requestTimelineSnapshot()`, `readConversationPage()`, queue delivery 변경과
clear API는 기존 Rubato control surface가 소비하던 이름과 shape를 유지한다. RPC `get_state`는 같은
`requestTimeline` snapshot을 반환한다.

`request-run.test.mjs`는 actual SDK에서 같은 text와 서로 다른 image의 submit/followUp/steer를 실행해
input event ID, pending ID, conversation entry ID, request-run ID가 같음을 확인한다. queue clear, active abort,
active reload, 429 retry 뒤 성공, unrecovered error를 연속 실행하고 이미 끝난 run의 status/completedAt이
뒤 이벤트로 바뀌지 않는 것도 검사한다. 별도 unbundled RPC child는 local fake stream provider로
`get_state`의 pending ID가 다음 completed run ID가 되는 것을 읽어 본다. compaction/retry gap의 단일
abort event 자체는 `abort-provenance.test.mjs`가 actual controller/backoff 경로에서 검증하며 tracker는
그 중간 이벤트를 terminal로 취급하지 않는다.

## 구현된 첫-user persistence와 session catalog 경계

`repo:harness/pi-runtime/features/session-catalog/`은 독립 catalog 모듈 한 개와
`dist/core/session-manager.{js,d.ts}` 두 exact-hash patch만 제공한다. `_persist()`는 user 또는 assistant
message가 하나 생기면 header와 지금까지의 metadata/message를 flush한다. 따라서 빈 세션이나 model
metadata만 있는 세션은 계속 파일을 만들지 않지만, provider가 응답하기 전 첫 user message는 즉시
복구 가능한 JSONL이 된다.

새 `SessionManager.listPage/listAllPage`는 stock의 최대 1 MiB bounded header reader와 기존
`buildSessionInfo()`를 callback으로 재사용한다. 먼저 header/cwd와 stat만 확인하고 mtime 내림차순,
동률이면 path 오름차순으로 고정한 뒤, 일반 목록에서는 요청한 최대 200개 page만 full-parse한다.
검색어가 있으면 이름·첫 메시지·전체 message text를 위한 index가 없으므로 scope의 session을
full-scan하고 결과 page만 잘라 반환한다. 이 검색 비용 차이는 API 계약이지 숨겨진 최적화 주장이 아니다.

`session-catalog.test.mjs`는 actual SessionManager에서 빈/metadata-only 세션이 파일을 만들지 않고
첫 user append가 즉시 flush되는지, 새 Node process가 그 파일을 다시 여는지, first-user-only 파일을
native `forkFrom()`이 복사하는지 확인한다. 120개 current-cwd session, 다른 cwd, malformed JSONL을
만들어 첫/둘째 page 순서와 중복 없음, mtime tie-break, cwd 격리, `total/hasMore`를 검사했다. 일반
12개 page의 progress callback은 12회만 호출됐고, 과거 메시지 검색은 의도대로 120회를 호출했다.
아직 연결하지 않은 것은 TUI session selector의 load-more/search 표현과 실제 picker 렌더 성능이다.

## 구현된 context-notes 기반 경계

`repo:harness/pi-runtime/features/context-notes/`는 stock 파일을 patch하지 않는다. 새 adapter 한 개와
현재 Rubato의 `extensions/context-notes.mjs`, `context-notes/*.mjs` 11개를 package 내부의 독립 feature
경로에 additive file로 복사한다. adapter는 stock TypeBox와 `getAgentDir()`를 사용한다. stock
`ExtensionContext`가 `agentDir`를 제공하지 않으므로 controller에는
`options.agentDir ?? ctx.agentDir` 순서로 전달한다. options가 없는 기존 Rubato 호출의 행동은 그대로다.
Senpi 전용 marker 일곱 개는 stock 0.85.1의 공개 compaction lifecycle과 일치하지 않으므로 이 adapter에서만
`requireEngine:false`로 두고, stock manual/automatic compaction은 기존 `session_before_compact` handler가
취소한다.

`context-notes.test.mjs`는 private staged runtime과 local `AssistantMessageEventStream`만 써서 다음을
실행한다.

- actual SDK provider context에서 GUIDANCE system prompt, bootstrap, 원래 user entry ID를 담은 history
  marker를 읽는다.
- 실제 stock tool registry로 note를 쓰고 JSONL custom entry와 session-keyed SQLite 양쪽의 저장을 확인한다.
- 실제 `AgentSession.reload()` 뒤 같은 note를 읽고, `AgentSessionRuntime.fork(...,{position:"at"})` 뒤
  새 session ID/SQLite에서 상속된 note와 window identity를 읽는다.
- actual unbundled RPC에서 두 turn의 provider context와 `get_entries`를 읽고, compact veto, reload,
  native `clone`, clone 뒤 provider context를 확인한다. 외부 provider나 gateway는 호출하지 않는다.

이 경로는 아직 public 후보 runtime에 등록하면 안 된다. GUIDANCE와 tool에는 `new_context`가 노출되지만
stock context에는 current controller가 요구하는 `getMessageRevision()`과
`applyCompaction(precomputed,{expectedRevision})`이 없다. 따라서 지금 등록하면 stock compaction은 막으면서
새 window로 전진하지 못한다. 다음 구현 단위는 이 두 revision-checked 접점, commit 뒤 next-turn context,
no-prune tool-result repair, provider/server compaction 우회 차단을 함께 닫은 뒤 descriptor를 catalog와
bootstrap에 넣는 것이다.

## 다음 구현 순서와 테스트 계약

reload, **입력 identity/disposition + gap-only abort provenance**, request-run ledger와
첫-user persistence/paged SDK catalog, context-notes 기반 저장·주입·reload/copy까지 공통 seam을 열었다.
다음은 context-notes의 revision-checked window commit을 닫아 descriptor를 안전하게 등록한 뒤 TUI session
picker, interactive-control bridge, paste/image/tmux 보강 순으로 진행하는 것이 결합 리스크가 낮다.

유료 provider 없이 다음 증거를 만든다.

| 묶음 | 최소 검증 |
|---|---|
| input/run | **완료:** inline extension + fake/local stream으로 같은 text·image의 submit/steer/follow-up, handled/rejected/started/queued, 각 ID의 단일 disposition과 queue 소비를 확인했다. 같은 actual SDK 흐름과 unbundled RPC `get_state`에서 pending/run ID와 completed/failed/interrupted 단일 terminal을 확인했다. |
| abort | **완료:** 실제 SDK fake stream/controller로 active user/system/provider abort, late join, retry backoff, compaction, cleared queue를 만들고 `agent_end` 또는 `session_abort` 하나만 발생하는지 확인했다. |
| sessions | **SDK 완료:** private temp first-user 파일을 새 process에서 열고 native fork했으며, 120개 목록의 newest-first paging/search/bad-file 격리와 full-parse count를 검사했다. **남음:** TUI picker load-more/search/rebind와 first-render 실측. |
| context notes | **기반 완료:** actual SDK/RPC에서 prompt/context injection, note JSONL+SQLite, reload, native clone과 public compact veto를 확인했다. **남음:** `/new-context` revision-checked commit과 next-turn window, no-prune repair, provider/server compaction 우회를 실제 경로로 검사한다. |
| remote/UI | in-memory fake hub/WebSocket + 실제 interactive host adapter로 duplicate request, stale revision, image input, reload veto, UI response/abort/session switch race를 검사한다. pending promise/listener가 0으로 정리되는지도 본다. |
| TUI | component/pseudo-TTY에서 regular↔fullscreen focus, collapsed paste, attachment transfer, Korean IME/combining/emoji/wide-char cursor와 mouse selection, tmux probe 결과를 검사한다. 실제 지원 terminal matrix는 별도 수동 렌더 검증을 남긴다. |

재현 명령:

```sh
cd harness/pi-runtime
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test \
  features/reload/reload.test.mjs \
  features/input-lifecycle/input-lifecycle.test.mjs \
  features/abort-provenance/abort-provenance.test.mjs \
  features/request-run/request-run.test.mjs \
  features/session-catalog/session-catalog.test.mjs \
  features/context-notes/context-notes.test.mjs
```

## 필수 의미와 조정 가능한 표현

반드시 같은 의미여야 하는 것은 입력 ID와 disposition, 중복 텍스트 queue 순서, request-run terminal
상태, gap-only abort, reload 원자성, 첫 입력 persistence, 대규모 session 목록의 bounded 첫 화면,
context-notes의 provider/compaction 소유권, remote idempotence·revision·UI cleanup, paste/image 무손실,
Unicode-safe cursor/selection, 그리고 inline image를 지원할 때의 tmux passthrough다.

조정 가능한 것은 page size `12`, 문구·border·spinner, tmux 경고 묶음/순서, reload 기본 안내 문구,
fullscreen의 시각 스타일이다. 다만 설정으로 제공되던 fullscreen 자체나 copy/exit 동작을
“미사용”으로 추정해 삭제할 수는 없다.

## 현재 coverage와 미검증 경계

- **구현·실행 확인:** reload SDK/TUI method/RPC, input identity/disposition, active/late/gap abort,
  request-run SDK/RPC snapshot과 단일 terminal, first-user restart/fork, bounded SDK catalog paging/search와
  context-notes prompt/context injection·note persistence·reload/native clone·RPC compact veto를 검증했다.
  각 patch의 pristine hash·anchor drift와 공통 stager의 전체 feature 합성은 통합 담당 검사가 정본이다.
- **소스 계약까지 확인:** TUI session picker, context-notes의 window commit 내부 접점, remote control/UI,
  fullscreen, paste/image, Unicode/mouse, tmux/local selector cleanup.
- **아직 구현하지 않음:** TUI session picker의 paged catalog 소비, interactive-control bridge,
  context-notes `getMessageRevision/applyCompaction` 및 next-turn/no-prune/server-compaction hook,
  paste/image/tmux 보강과 해당 제품 wiring. context-notes descriptor는 이 경계가 닫힐 때까지 public
  후보 runtime의 catalog/bootstrap에 등록하지 않는다.
- **아직 실행하지 않음:** 실제 terminal/picker 렌더링, 실제 remote hub/mobile, 대규모 기존
  session 복사본의 `/resume` 시간·호환, context-notes의 모든 compaction lane 결합, 유료 provider E2E.
- **목록 한계:** 이 문서는 지정된 session/control/UI 그룹의 contract inventory다. Senpi builtin 전체
  등록 목록과 provider/tool/auth/runtime 배포의 완전성은 각 담당 inventory가 정본이며,
  여기서 전체 제품 parity를 주장하지 않는다.

이 영역의 stop 조건은 위 순서의 남은 기능을 별도 소유권으로 구현·검증한 뒤 전체 Rubato 후보
런타임에서 기존 세션/remote/TUI 시나리오가 green인 때다. 현재 reload, input lifecycle,
abort provenance, request-run, first-user persistence와 SDK catalog, context-notes 기반 저장·주입·reload/copy는
실제 경로 검증 수준에 도달했으며 TUI/remote/context-notes window transition의 전체 제품 wiring은 아직
완료가 아니다.
