# Tool 실행 이관 계약: MCP, tool search, eval/codemode, PTY

결론: stock Pi 0.85.1에 **일반 `executeTool` seam, owner-controlled lazy activation,
session-owned MCP stdio client, BM25 `tool_search` catalog**가 연결됐다. MCP tool은 초기 active
set에서 빠져 있고, `tool_search`가 MCP owner callback으로 활성화한 직후 같은 host turn에서
일반 executor로 호출할 수 있다. 이 경로는 schema validation, `tool_call` block/input mutation,
progress, `tool_result` mutation/error, AbortSignal을 모두 stock AgentSession hook에 통과시킨다.
reload에서는 stale activator가 제거되고 ownership-aware history marker만 재활성화하며,
shutdown에서는 MCP subprocess가 종료된다.

이 완료 범위는 eval/codemode가 소비할 실행 접점과 MCP lazy/search다. codemode의 recursive
kernel/assets 및 PTY native/runtime graph 자체는 각 owner의 별도 이관 경계이며, 여기서
대역이나 Senpi runtime fallback으로 대신하지 않는다.

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
| stock extension registration | stock 공개 API에는 dynamic `registerTool`, `exec`, active/all/set tools가 있다(`$STOCK/dist/core/extensions/types.d.ts:943-999`). 등록은 즉시 runtime refresh를 부른다(`.../loader.js:238-245`); AgentSession은 새 definition을 registry에 넣고 처음 본 extension tool을 active로 만든다(`$STOCK/dist/core/agent-session.js:2105-2180`). 장기 자원은 factory가 아니라 `session_start`에서 열고 `session_shutdown`에서 닫는 것이 공개 계약이다(`$STOCK/docs/extensions.md:220-224,1365-1373`). | `features/mcp/extension.mjs:7-67`의 `createMcpExtension(options)`가 lifecycle을 소유한다. `toolSearchService`가 없으면 기존 direct 등록, 있으면 등록 직전 active set을 복구하고 MCP feed만 catalog identity를 소유한다. shutdown 후 같은 factory가 새 subprocess/proxy를 만든다. | 자동 server declaration discovery와 producer 설정 조립은 공통 bootstrap 소유다. SDK embedder는 정상 `bindExtensions` 경로를 사용해야 한다. |
| tool surface/search | Rubato core는 `read/bash/apply_patch/todo/tool_search`뿐이고 나머지는 search 노출이다(`harness/rubato-pi/src/tool-surface-policy.mjs:1-53`). ToolSearchService는 source별 catalog/activation owner, history rehydrate, BM25 검색을 가진다(`$SENPI/dist/core/extensions/builtin/tool-search/service.js:6-145`). | `features/tool-search/service.mjs:7-164`가 MCP/extension feed를 한 이름당 한 owner identity로 유지한다. `index.mjs:4-24`가 search-exposed extension tools를 inactive로 만들고 lazy activator를 등록한다. v2 owner marker와 legacy MCP marker를 복원하며, `tool.mjs` 결과는 일반 executor에서 즉시 호출 가능함을 명시한다. | Anthropic provider-native `tool_search_tool_bm25` request rewriting/fallback은 아직 이 slice에 포함되지 않았다. local `tool_search` 실행과 동일하다고 주장하지 않는다. |
| generic executeTool | Senpi는 inactive definition이면 owner activator를 거친 뒤 schema 준비, `tool_call` preflight, wrapped execute, `tool_result` hooks를 실행한다(`$SENPI/dist/core/agent-session.js:2200-2279`). extension runtime에 이를 바인딩한다(`.../agent-session.js:5509-5519`). stock ExtensionAPI에는 이 메서드가 없다(`$STOCK/dist/core/extensions/types.d.ts:943-999`). | `features/tool-execution/runtime.mjs:19-108`가 active wrapped registry를 resolve하고 stock validator와 agent before/after hooks를 호출한다. Pi core patch는 `pi.executeTool`과 `pi.registerLazyToolActivator`를 bind하는 thin seam뿐이다. owner가 활성화하지 않으면 core는 inactive tool을 임의로 켜지 않는다. | API 오류는 `unknown_tool/inactive_tool/invalid_params/blocked`; 실제 tool throw/abort는 `tool_result` hook을 거친 error `AgentToolResult`다. executor는 MCP를 알지 못하며 codemode도 동일 API를 사용한다. |
| codemode/eval | 현재 Rubato entry는 eval 등록, persistent runtime, detached cell notifier/status, shutdown/switch/fork 정리를 보존한다(`harness/rubato-pi/src/codemode/index.ts:39-65,98-207`). 세 overlay만이 아니라 worker/prelude/bridge/kernel graph 전체가 필요하다. | 99개 source/asset을 runtime-owned feature로 stage했고 Senpi imports를 stock host adapter로 바꿨다. 실제 staged AgentSession에 bind해 persistent JS와 inactive MCP same-turn 호출을 검증했다. 상세 계약과 증거는 [codemode.md](./codemode.md)에 있다. | Python/Ruby/Julia/Bun 실행 E2E, image/TUI 및 provider-backed completion은 아직 남아 있다. 배포 파일 포함과 각 interpreter 실제 실행 증거를 구분한다. |
| eval persistence/detach | manager는 언어별 kernel을 cell 사이에 재사용하고 message sink를 매 cell 재결합한다(`$CODEMODE/src/extension/session-manager.ts:72-136`). dispose는 생성 중 kernel까지 기다린 뒤 모든 kernel과 HTTP bridge를 닫고 실패를 모은다(`:152-177`). detached cell은 peek/stop/hard wall-clock kill/notification flush를 가진다(`$CODEMODE/src/tool/detached-cell-manager.ts:101-195,232-260`). | JS worker에서 두 cell persistence, eval 내부 generic executor, detach → peek → stop, notification 1회, manager/bridge shutdown을 실제 프로세스로 검증했다. `activateInactiveTool:true`는 이 문서의 일반 executor를 소비하며 MCP를 우회하지 않는다. | 다른 interpreter의 persistence/tool bridge/cancellation/process-group 종료는 아직 실행하지 않았다. stock removed-tool adapter는 다음 provider context 안내까지 검증됐지만 최초 TUI/session 오류 문자열 자체는 native Senpi와 다르다. |
| PTY/bash family | Senpi terminal builtin은 `bash`, `bash_input`, `bash_output`, `bash_resize`, `kill_bash`, `monitor`와 공유 manager/session bundle을 함께 등록한다(`$SENPI/dist/core/extensions/builtin/terminal/extension.js:1-24,98-173`). reload 때 bundle을 park하고 teardown한다(`.../terminal/session-bundle.js:5-109`). manager는 PTY SessionRegistry와 cleanup을 소유한다(`.../terminal/manager.js:1-20,42-66,97-110`). | `@code-yeongyu/senpi-pty`의 작은 공개 facade만 흉내 내지 않고, PTY library + terminal builtin graph를 Rubato-owned feature로 source/artifact 단위 이식한다. stock TUI의 화면용 process terminal은 이 persistent shell 계약의 대체가 아니다. | 현재 확보한 native prebuild는 Darwin arm64 하나뿐이다. 지원 OS/arch matrix, native source/build provenance, Linux/Windows prebuild, 서명/해시와 license 원문을 확보하기 전에는 배포 parity가 아니다. |
| Rubato MCP producers | ast-grep은 `_ast_grep`, Node entry, project cwd env, enabled/eager/2초 startup을 선언한다(`packages/rubato-runtime/src/components/ast-grep/index.ts:13-51`). memory는 기본 direct tool이고 opt-in search일 때만 enabled MCP server를 선언한다(`packages/rubato-runtime/src/components/memory/tools.ts:142-176`). | bootstrap은 두 producer를 service declaration/catalog 입력으로 변환한다. memory의 기본 direct behavior는 유지하고 설정이 search일 때만 stdio MCP로 전환한다. | `registerMcpServer`가 없다고 조용히 skip하는 현재 compatibility branch를 새 stock 경로의 정상 동작으로 삼으면 안 된다. producer별 entry existence와 startup failure를 사용자가 볼 수 있어야 한다. |

## 구현된 공개 API와 조립점

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

const search = new ToolSearchService();
const extensions = [
  createToolSearchExtension(search),
  createMcpExtension({ servers, toolSearchService: search }),
];

const result = await pi.executeTool(name, rawParams, {
  signal,
  onUpdate,
  activateInactiveTool: true,
});
pi.registerLazyToolActivator((toolName) => search.activateTool(toolName));
```

- `createMcpService`가 subprocess/client와 proxy catalog의 lifecycle owner다. 인스턴스는
  한 session용이며 close 후 재시작하지 않는다.
- `createMcpExtension`은 각 `session_start`에 service를 만들고 tool을 stock
  `pi.registerTool`로 등록한다. injected search service가 있으면 MCP catalog와 activation owner도
  연결한다. `session_shutdown` 뒤 같은 factory가 재사용되면 새 service를 만든다.
- build descriptor는 `mcpFeature`(`features/mcp/feature.mjs`), `toolExecutionFeature`
  (`features/tool-execution/index.mjs`), `toolSearchFeature`(`features/tool-search/feature.mjs`)다.
  소유 구현은 stage root의 `rubato-features/<feature>/` 아래로 복사된다. tool-execution은 Pi
  package의 AgentSession/ExtensionAPI에 narrow import/delegate patch를 추가하고, tool-search는
  exposure/catalog metadata patch를 추가한다. MCP는 Pi package patch 없이 공개 extension API만 쓴다.
  어느 경로도 shared fixture나 Senpi 설치를 runtime import하지 않는다.
- 빈/중복 server name, stdio가 아닌 declaration, 잘못된 args/env/timeout은 시작 전에 실패한다.
  initialize/list 실패는 `MCP_SERVER_START_FAILED`; unknown proxy와 MCP `isError` 결과도 별도
  `McpServiceError.code`로 보존한다.
- 현재 export는 `harness/pi-runtime/features/mcp/index.mjs:1-2`, 구현은
  `service.mjs:24-225`, lifecycle adapter는 `extension.mjs:7-27`이다.

## 재귀 의존성과 배포 자산

| 기능 | 실제 필요한 package/source/resource | 라이선스/배포 상태 |
|---|---|---|
| MCP client | `@modelcontextprotocol/sdk@1.30.0`; 사용 entry는 `client/index.js`, `client/stdio.js`. package가 선언하는 runtime graph는 `@hono/node-server`, `ajv`, `ajv-formats`, `content-type`, `cors`, `cross-spawn`, `eventsource`, `eventsource-parser`, `express`, `express-rate-limit`, `hono`, `jose`, `json-schema-typed`, `pkce-challenge`, `raw-body`, `zod`, `zod-to-json-schema`와 그 transitive graph다. 정확 버전/SRI는 standalone `package-lock.json`이 소유한다. `packages/mcp-stdio-core/package.json:2-36`과 `src/server.ts:27-103`은 server framing/read loop일 뿐 client가 아니다. | SDK는 MIT이며 standalone manifest/lock에 고정됐다. `compat.mjs`가 보존한 Senpi-origin behavior의 MIT notice는 `features/mcp/THIRD_PARTY_NOTICES.md`에 포함했다. 설치된 main Senpi package는 `package.json:343`에서 MIT를 선언하지만 root LICENSE가 없어서, 동일 repository/release의 codemode package에 실제 포함된 LICENSE 원문과 SHA-256을 notice에 기록했다. |
| codemode | `$CODEMODE/src/**` 전체가 실제 import graph다. runtime 외부 package는 `@babel/parser@8.0.4`, `typebox@1.3.18` (`typebox/value` 포함), stock Pi host helpers다. sidecar assets는 JS worker 6개, `py/prelude.py`, Ruby/Julia runner+prelude, `src/skill/bun-1-4/**`다. 정확한 99개 inventory와 resolution은 [codemode.md](./codemode.md)에 있다. | runtime-root feature에 source/assets와 실제 MIT `LICENSE`를 함께 stage한다. 기존 package를 그대로 설치할 때 생기는 Senpi alias/peer fallback은 제거했고, staged inventory test가 금지 import 부재를 검사한다. |
| PTY/terminal | `$PTY/dist/**`의 loader/native-loader/pipe fallback/quarantine/registry/session/screen module 전체, `@xterm/headless@6.0.0`, 그리고 `$PTY/native/index.js` + native binary가 필요하다. 현재 fixture의 binary는 `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node` 하나다. terminal extension 쪽 manager/session-bundle/tools graph도 별도 필요하다. | package manifest는 MIT를 선언하지만 published `files`에는 LICENSE가 없다(`$PTY/package.json:27-30,45-56`). native source와 타 플랫폼 artifact도 현재 inventory에 없다. upstream 원문 license, native source/provenance와 target prebuild를 확보해야 배포 가능하다. |

stock coding-agent가 이미 제공하는 `convertToPng`, `resizeImage`, `formatDimensionNote`는 stock
root export로 다시 연결할 수 있다. 반면 codemode가 가져오는 `sanitizeTerminalLabel` 등은
실제 stock export 위치를 하나씩 대조해야 한다. type-only import가 컴파일된다는 사실은 worker,
prelude, bridge, interpreter process가 실제로 실행된다는 증거가 아니다.

## 첫 완전 검증 경로

이번 executor + MCP lazy/search slice의 재현 명령은 다음이다.

```sh
cd harness/pi-runtime
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE npm test --workspaces=false
```

현재 검증은 local fake stdio subprocess와 `resolvePiRuntime({root}).sdkEntry`로 동적 import한
실제 staged `DefaultResourceLoader/createAgentSession`을 사용한다. fake registration만 검사하지
않는다. `features/mcp/mcp.test.mjs`, `features/tool-execution/tool-execution.test.mjs`,
`features/tool-search/tool-search.test.mjs`가 다음을 고정한다.

1. initialize → 2-page tools/list → 이름/schema 변환
2. call → progress → text/structured/rich result → MCP `isError`
3. AbortSignal → MCP cancellation notification → child가 실제 취소 관찰
4. service shutdown → child exit
5. startup failure → 앞서 열린 child rollback
6. stock AgentSession all/active registry와 generic executor의 validation/hook mutation/block/result
7. inactive/unknown/hard-disabled lookup, owner activation, update, thrown error와 abort result
8. MCP catalog-only → BM25 `tool_search` → 같은 host turn의 real stdio proxy call
9. ownership-aware marker → reload → 새 subprocess와 valid activation만 복원 → shutdown
10. all-selected feature stage에서 tool name당 catalog owner가 하나뿐임

집중 검증은 executor `3/3`, lazy/search E2E `1/1`, all-selected composition `1/1`이다.
standalone 전체의 최신 결과는 `README.md` 실행 기록이 정본이다. 비용 드는 provider 요청이나
user profile은 사용하지 않았다.

전체 tool 경로의 다음 최소 E2E는 아래 순서를 끊지 않고 통과해야 한다.

- **MCP search (완료):** initialize/list → catalog에는 있고 active set에는 없음 → `tool_search`
  실행과 history marker → 같은 host turn에서 generic executor로 proxy call → result/abort →
  reload 시 owner/registration id가 일치한 history만 복원 → shutdown child exit.
- **eval:** JS 첫 cell에서 값을 만들고 두 번째 cell에서 읽어 persistence 확인 → inactive/search
  tool을 cell 안에서 generic executor로 호출 → 긴 cell detach → peek → stop → 상태 보존 여부와
  알림 1회 확인 → session shutdown에서 worker, interpreter subprocess, bridge가 모두 종료.
  Python/Ruby/Julia는 detected interpreter마다 같은 subprocess cancellation/process-tree 검사를 한다.
- **PTY:** persistent bash 시작/출력 cursor → input → resize → monitor → command completion 후 재사용 →
  kill/timeout → reload park/rebind → shutdown에서 PTY와 descendant process가 모두 종료. pipe fallback은
  resize/screen 기능 차이를 명시적으로 시험하고 native PTY와 동등하다고 가정하지 않는다.

## 완료로 말할 수 있는 범위

지금 완료된 것은 explicit declaration을 받은 **stdio MCP direct/lazy registration + local BM25
search/history + generic executor**다. codemode도 staged source/assets와 실제 stock SDK의 JS
eval/tool/detach/shutdown까지 연결됐으며 자세한 미검증 경계는 [codemode.md](./codemode.md)가 정본이다.
MCP health/retry/output guard, Anthropic native search adapter, 비-JS interpreter E2E, PTY, 설정 discovery,
memory search-mode producer, 전체 launcher/install/update는 각 소유 경계에서 아직 pending이다. 이 항목들이 연결되고 전체 E2E가 통과하기 전에는
`fullRubatoParity`를 true로 바꾸거나 실사용 기본 엔진을 전환하면 안 된다.
