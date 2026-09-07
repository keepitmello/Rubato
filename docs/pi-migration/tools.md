# Tool 실행 이관 계약: MCP, tool search, eval/codemode, PTY

결론: stock Pi 0.85.1의 공개 extension API만으로 완결되는 첫 단위는 **stdio MCP의
직접 등록 경로**다. 이번 구현은 실제 MCP SDK로 서버를 초기화하고, 전체 tool 목록을
페이지 순회하고, proxy를 동적 등록하며, call/progress/error/abort/shutdown과 같은 runner의
두 번째 session까지 검증했다. 이것은 실행 가능한 기반이지만 현재 Rubato의
`tool_search` lazy 노출이나 eval/PTY parity까지 완료했다는 뜻은 아니다.

eval이 inactive/search tool을 직접 실행하는 데 필요한 일반 `executeTool` 접점은 stock
ExtensionAPI에 없다. MCP 전용 우회로를 추가하지 않고, AgentSession의 기존 validation과
tool hooks를 통과하는 좁은 일반 실행 접점 하나를 core patch로 제공하는 것이 다음 경계다.
codemode와 PTY는 각각 재귀적인 source/runtime asset과 native artifact를 가진 별도 기능
패키지로 옮겨야 한다. 현재 Rubato의 수정 파일 세 개만 복사하거나 `child_process` 대역으로
바꾸면 기능이 누락된다.

## 근거 경로 표기

아래 표의 긴 설치 경로는 다음 이름으로 줄여 쓴다. 이 경로들은 조사 입력이며 새 runtime이
실행 중 fallback할 위치가 아니다.

- `$STOCK`: `harness/pi-runtime/node_modules/@earendil-works/pi-coding-agent`
- `$SENPI`: 원본 checkout의
  `rubato/node_modules/.bun/@code-yeongyu+senpi@2026.9.4-3+bcafad38bfc859d1/node_modules/@code-yeongyu/senpi`
- `$CODEMODE`: 원본 checkout의
  `rubato/node_modules/.bun/@code-yeongyu+senpi-codemode@2026.9.4-3+f35ab539f07c9f4c/node_modules/@code-yeongyu/senpi-codemode`
- `$PTY`: 원본 checkout의
  `rubato/node_modules/.bun/@code-yeongyu+senpi-pty@2026.9.4-3/node_modules/@code-yeongyu/senpi-pty`

## 기능별 계약과 구현 경계

| 경로 | 현재 보존해야 하는 계약과 근거 | 이번 선택 | 남은 경계 |
|---|---|---|---|
| MCP stdio lifecycle | MCP SDK `Client` + `StdioClientTransport`로 initialize 후 페이지별 `tools/list`; call은 timeout/signal/progress를 전달하고 `isError`를 실행 오류로 만든다. Senpi 기준은 `$SENPI/dist/core/extensions/builtin/mcp/expose/register.js:24-95`, pagination은 `.../pagination.js:1-28`, schema/result 변환은 `.../schema-compat.js:5-137`이다. | `harness/pi-runtime/features/mcp/service.mjs:24-225`의 session-owned service. declaration은 `{name,type:"stdio",command,args?,cwd?,env?,requestTimeoutMs?,stderr?}`로 명시 주입한다. 시작 실패는 서버 이름이 든 오류로 거부하고 이미 열린 client를 rollback한다. 종료 오류도 `AggregateError`로 드러낸다. | 현재 Senpi의 health/retry/session-expiry/output-guard는 아직 옮기지 않았다(`register.js:51-67`). 서버 설정 discovery와 enabled/eager/search 정책도 bootstrap/tool-search owner가 연결해야 한다. |
| MCP identity/schema/result | 현재 Rubato wire name은 `mcp__<server>_<tool>`이며 선두 `_` server는 추가 `_`를 접는다. Rubato transform 근거는 `harness/rubato-pi/src/transforms/core-tool-surface.mjs:68-101`; Senpi의 64자 제한, `-`/`_` 충돌, SHA-1 4자리 suffix는 `$SENPI/.../mcp/expose/naming.js:1-55`다. | `features/mcp/compat.mjs:5-197`에서 같은 이름/충돌, local `$ref`, top-level `$schema`/`additionalProperties`, rich content/structured content를 보존한다. `same-name` fixture의 실제 suffix `5f5b`, `same_name`의 `f23a`를 고정했다. | output guard 및 artifact spill은 아직 없음. 이 단계에서 이름을 stock Senpi의 `mcp_`로 되돌리면 Anthropic 경로와 기존 prompt/tool identity가 깨진다. |
| stock extension registration | stock 공개 API에는 dynamic `registerTool`, `exec`, active/all/set tools가 있다(`$STOCK/dist/core/extensions/types.d.ts:943-999`). 등록은 즉시 runtime refresh를 부른다(`.../loader.js:238-245`); AgentSession은 새 definition을 registry에 넣고 처음 본 extension tool을 active로 만든다(`$STOCK/dist/core/agent-session.js:2105-2180`). 장기 자원은 factory가 아니라 `session_start`에서 열고 `session_shutdown`에서 닫는 것이 공개 계약이다(`$STOCK/docs/extensions.md:220-224,1365-1373`). | `features/mcp/extension.mjs:7-27`의 `createMcpExtension(options)`가 공개 API만 사용한다. shutdown 때 service 참조를 지운 뒤 닫아서 같은 factory/runner가 다시 start될 때 새 subprocess와 새 proxy closure를 만든다. | 자동 discovery 및 전체 Rubato extension 조립은 공통 bootstrap 소유다. `createAgentSession` 뒤 extension binding을 생략하면 lifecycle이 시작되지 않으므로 SDK embedder는 정상 binding 경로를 사용해야 한다. |
| tool surface/search | Rubato core는 `read/bash/apply_patch/todo/tool_search`뿐이고 나머지는 search 노출이다(`harness/rubato-pi/src/tool-surface-policy.mjs:1-53`). ToolSearchService는 source별 catalog/activation owner, history rehydrate, BM25 검색을 가진다(`$SENPI/dist/core/extensions/builtin/tool-search/service.js:6-145`). 현재 copy는 검색 결과 직후 같은 user turn에 호출 가능하다고 명시한다(`harness/rubato-pi/src/transforms/core-tool-surface.mjs:112-127`). | 이번 MCP module은 full proxy를 **직접 등록**하는 최소 실행 단위다. 이를 complete search parity라고 노출하지 않는다. 다음 단계에서 Rubato-owned ToolSearchService가 MCP catalog를 유일하게 소유하고, 검색 결과만 active set에 올린다. | stock API에는 `registerLazyToolActivator`, exposure metadata, history marker owner가 없다. search catalog/activation/rehydrate와 same-turn call을 한 묶음으로 이식해야 한다. MCP module 안에 단순 문자열 검색 stub을 넣지 않는다. |
| generic executeTool | Senpi는 inactive definition이면 owner activator를 거친 뒤 schema 준비, `tool_call` preflight, wrapped execute, `tool_result` hooks를 실행한다(`$SENPI/dist/core/agent-session.js:2200-2279`). extension runtime에 이를 바인딩한다(`.../agent-session.js:5509-5519`). stock ExtensionAPI에는 이 메서드가 없다(`$STOCK/dist/core/extensions/types.d.ts:943-999`). | core에 MCP와 무관한 `executeRegisteredTool(name, rawParams, {signal?,onUpdate?})` 하나를 제공한다. 구현은 현재 AgentSession의 active wrapped registry, argument preparation/validation, preflight와 after hooks를 반드시 재사용한다. | inactive 활성화 자격은 core가 임의로 `setActiveTools`하지 않는다. Rubato ToolSearchService의 `activateTool(name)`을 injected callback으로 받아 성공 후 다시 active registry에서 resolve한다. error code `unknown_tool/inactive_tool/invalid_params/blocked`와 abort/update를 계약 테스트로 고정해야 한다. |
| codemode/eval | 현재 Rubato entry는 eval 등록, persistent runtime, detached cell notifier/status, shutdown/switch/fork 정리를 보존한다(`harness/rubato-pi/src/codemode/index.ts:39-65,98-207`). vendor filename으로 jiti 평가해서 나머지 상대 import는 vendor package로 보낸다(`harness/rubato-pi/src/transforms/control-codemode-redirect.mjs:17-56`). 즉 in-repo 수정 세 파일은 전체 runtime이 아니다. | MIT source를 Rubato-owned 독립 codemode package/feature로 source-scoped 이식한다. host imports를 stock Pi suite와 위 generic executor로 바꾸고, 현재 세 Rubato overlay를 합친다. Senpi package를 runtime fallback/peer로 설치하지 않는다. | JS/Python/Ruby/Julia kernel, bridge, completion, images, renderers, settings, skill contribution까지 재귀 이식 및 E2E가 남았다. interpreter별 availability가 disabled tool surface에 반영되는지도 검증해야 한다. |
| eval persistence/detach | manager는 언어별 kernel을 cell 사이에 재사용하고 message sink를 매 cell 재결합한다(`$CODEMODE/src/extension/session-manager.ts:72-136`). dispose는 생성 중 kernel까지 기다린 뒤 모든 kernel과 HTTP bridge를 닫고 실패를 모은다(`:152-177`). detached cell은 peek/stop/hard wall-clock kill/notification flush를 가진다(`$CODEMODE/src/tool/detached-cell-manager.ts:101-195,232-260`). subprocess kernel은 graceful stop 후 process group kill을 수행한다(`$CODEMODE/src/kernels/shared/subprocess-process.ts:39-173`). | 위 전체 manager를 기능 경계로 유지한다. eval cell 안의 tool call도 generic executor를 통해 일반 tool과 같은 permission/hooks/result semantics를 사용한다. | `executeTool(...activateInactiveTool:true)`에 해당하는 stock 연결 전에는 codemode를 완성으로 표시할 수 없다. persistent/detach/stop/shutdown 실프로세스 검증이 필요하다. |
| PTY/bash family | Senpi terminal builtin은 `bash`, `bash_input`, `bash_output`, `bash_resize`, `kill_bash`, `monitor`와 공유 manager/session bundle을 함께 등록한다(`$SENPI/dist/core/extensions/builtin/terminal/extension.js:1-24,98-173`). reload 때 bundle을 park하고 teardown한다(`.../terminal/session-bundle.js:5-109`). manager는 PTY SessionRegistry와 cleanup을 소유한다(`.../terminal/manager.js:1-20,42-66,97-110`). | `@code-yeongyu/senpi-pty`의 작은 공개 facade만 흉내 내지 않고, PTY library + terminal builtin graph를 Rubato-owned feature로 source/artifact 단위 이식한다. stock TUI의 화면용 process terminal은 이 persistent shell 계약의 대체가 아니다. | 현재 확보한 native prebuild는 Darwin arm64 하나뿐이다. 지원 OS/arch matrix, native source/build provenance, Linux/Windows prebuild, 서명/해시와 license 원문을 확보하기 전에는 배포 parity가 아니다. |
| Rubato MCP producers | ast-grep은 `_ast_grep`, Node entry, project cwd env, enabled/eager/2초 startup을 선언한다(`packages/rubato-runtime/src/components/ast-grep/index.ts:13-51`). memory는 기본 direct tool이고 opt-in search일 때만 enabled MCP server를 선언한다(`packages/rubato-runtime/src/components/memory/tools.ts:142-176`). | bootstrap은 두 producer를 service declaration/catalog 입력으로 변환한다. memory의 기본 direct behavior는 유지하고 설정이 search일 때만 stdio MCP로 전환한다. | `registerMcpServer`가 없다고 조용히 skip하는 현재 compatibility branch를 새 stock 경로의 정상 동작으로 삼으면 안 된다. producer별 entry existence와 startup failure를 사용자가 볼 수 있어야 한다. |

## 이번에 구현된 공개 API

```js
const service = createMcpService({
  servers: [{
    name: "example",
    type: "stdio",
    command: process.execPath,
    args: [serverEntry],
    cwd,
    env,
    requestTimeoutMs: 60_000,
  }],
});

const tools = await service.start();
const result = await service.callTool(tools[0].name, args, { signal, onUpdate });
await service.close();

const extensionFactory = createMcpExtension({ servers });
```

- `createMcpService`가 subprocess/client와 proxy catalog의 lifecycle owner다. 인스턴스는
  한 session용이며 close 후 재시작하지 않는다.
- `createMcpExtension`은 각 `session_start`에 service를 만들고 tool을 stock
  `pi.registerTool`로 등록한다. `session_shutdown` 뒤 같은 factory가 재사용되면 새 service를 만든다.
- 빈/중복 server name, stdio가 아닌 declaration, 잘못된 args/env/timeout은 시작 전에 실패한다.
  initialize/list 실패는 `MCP_SERVER_START_FAILED`; unknown proxy와 MCP `isError` 결과도 별도
  `McpServiceError.code`로 보존한다.
- 현재 export는 `harness/pi-runtime/features/mcp/index.mjs:1-2`, 구현은
  `service.mjs:24-225`, lifecycle adapter는 `extension.mjs:7-27`이다.

## 재귀 의존성과 배포 자산

| 기능 | 실제 필요한 package/source/resource | 라이선스/배포 상태 |
|---|---|---|
| MCP client | `@modelcontextprotocol/sdk@1.30.0`; 사용 entry는 `client/index.js`, `client/stdio.js`. package가 선언하는 runtime graph는 `@hono/node-server`, `ajv`, `ajv-formats`, `content-type`, `cors`, `cross-spawn`, `eventsource`, `eventsource-parser`, `express`, `express-rate-limit`, `hono`, `jose`, `json-schema-typed`, `pkce-challenge`, `raw-body`, `zod`, `zod-to-json-schema`와 그 transitive graph다. 정확 버전/SRI는 standalone `package-lock.json`이 소유한다. `packages/mcp-stdio-core/package.json:2-36`과 `src/server.ts:27-103`은 server framing/read loop일 뿐 client가 아니다. | SDK는 MIT이며 standalone manifest/lock에 고정됐다. `compat.mjs`가 보존한 Senpi-origin behavior의 MIT notice는 `features/mcp/THIRD_PARTY_NOTICES.md`에 포함했다. 설치된 main Senpi package는 `package.json:343`에서 MIT를 선언하지만 root LICENSE가 없어서, 동일 repository/release의 codemode package에 실제 포함된 LICENSE 원문과 SHA-256을 notice에 기록했다. |
| codemode | `$CODEMODE/src/**` 전체가 실제 import graph다. runtime 외부 package는 `@babel/parser@8.0.4`, `typebox@1.3.18` (`typebox/value` 포함), stock `@earendil-works/pi-ai/compat`, coding-agent type/runtime helpers, pi-tui helper다. sidecar assets는 JS worker `worker-entry.js`, `inline-worker-entry.js`, `worker-core.js`, `worker-runtime.js`, `worker-indirect-eval.js`, `worker-shell-capture.js`; `py/prelude.py`; `rb/runner.rb` + `prelude.rb`; `jl/runner.jl` + `prelude.jl`; `src/skill/bun-1-4/**`다. asset resolution 근거는 `$CODEMODE/src/kernels/shared/runtime-asset.ts:1-30`, skill contribution은 `.../extension/skill-contribution.ts`다. | package는 MIT이고 `LICENSE`가 실제 포함된다(`$CODEMODE/package.json:12-17,31-56`). 이식 시 그 원문과 source provenance를 함께 둔다. 기존 dependency가 `@earendil-works/pi-ai`를 Senpi alias로 지정하고 Senpi peer를 요구하므로 package를 그대로 설치하면 금지된 hidden fallback이다(`package.json:31-40`). |
| PTY/terminal | `$PTY/dist/**`의 loader/native-loader/pipe fallback/quarantine/registry/session/screen module 전체, `@xterm/headless@6.0.0`, 그리고 `$PTY/native/index.js` + native binary가 필요하다. 현재 fixture의 binary는 `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node` 하나다. terminal extension 쪽 manager/session-bundle/tools graph도 별도 필요하다. | package manifest는 MIT를 선언하지만 published `files`에는 LICENSE가 없다(`$PTY/package.json:27-30,45-56`). native source와 타 플랫폼 artifact도 현재 inventory에 없다. upstream 원문 license, native source/provenance와 target prebuild를 확보해야 배포 가능하다. |

stock coding-agent가 이미 제공하는 `convertToPng`, `resizeImage`, `formatDimensionNote`는 stock
root export로 다시 연결할 수 있다. 반면 codemode가 가져오는 `sanitizeTerminalLabel` 등은
실제 stock export 위치를 하나씩 대조해야 한다. type-only import가 컴파일된다는 사실은 worker,
prelude, bridge, interpreter process가 실제로 실행된다는 증거가 아니다.

## 첫 완전 검증 경로

이번 direct MCP slice의 재현 명령은 다음이다.

```sh
cd harness/pi-runtime
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE npm test --workspaces=false
```

현재 검증은 local fake stdio subprocess와 `resolvePiRuntime({root}).sdkEntry`로 동적 import한
실제 stock `DefaultResourceLoader/createAgentSession`을 사용한다. fake registration만 검사하지
않는다. `features/mcp/mcp.test.mjs`가 다음을 고정한다.

1. initialize → 2-page tools/list → 이름/schema 변환
2. call → progress → text/structured/rich result → MCP `isError`
3. AbortSignal → MCP cancellation notification → child가 실제 취소 관찰
4. service shutdown → child exit
5. startup failure → 앞서 열린 child rollback
6. stock AgentSession의 all/active registry → definition execute → shutdown
7. 같은 runner/factory의 두 번째 session start → 새 subprocess/definition/call → 두 번째 shutdown

MCP 집중 검증은 `4 tests, 4 pass`다. standalone 전체의 최신 결과는 `README.md` 실행 기록이
정본이다. 비용 드는 provider 요청이나 user profile은 사용하지 않았다.

전체 tool 경로의 다음 최소 E2E는 아래 순서를 끊지 않고 통과해야 한다.

- **MCP search:** initialize/list → catalog에는 있고 active set에는 없음 → `tool_search`
  실행과 history marker → 같은 user turn의 다음 model step에서 proxy call → result/error/abort →
  reload 또는 shutdown 시 child exit. 새 session history rehydrate는 owner와 registration id가
  일치할 때만 다시 활성화해야 한다.
- **eval:** JS 첫 cell에서 값을 만들고 두 번째 cell에서 읽어 persistence 확인 → inactive/search
  tool을 cell 안에서 generic executor로 호출 → 긴 cell detach → peek → stop → 상태 보존 여부와
  알림 1회 확인 → session shutdown에서 worker, interpreter subprocess, bridge가 모두 종료.
  Python/Ruby/Julia는 detected interpreter마다 같은 subprocess cancellation/process-tree 검사를 한다.
- **PTY:** persistent bash 시작/출력 cursor → input → resize → monitor → command completion 후 재사용 →
  kill/timeout → reload park/rebind → shutdown에서 PTY와 descendant process가 모두 종료. pipe fallback은
  resize/screen 기능 차이를 명시적으로 시험하고 native PTY와 동등하다고 가정하지 않는다.

## 완료로 말할 수 있는 범위

지금 완료된 것은 explicit declaration을 받은 **stdio MCP direct registration + lifecycle**이다.
MCP lazy search, catalog history, health/retry/output guard, codemode, eval executor, PTY, 설정 discovery,
memory search mode, 전체 launcher/install/update는 아직 pending이다. 이 항목들이 연결되고 위 E2E가
통과하기 전에는 `fullRubatoParity`를 true로 바꾸거나 실사용 기본 엔진을 전환하면 안 된다.
