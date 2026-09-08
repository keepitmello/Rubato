# Tool policy on stock Pi 0.85.1

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

결론: Senpi의 tool-policy 실행 핵심을 stock Pi의 공개 Extension API 위에 분리했다. 빌드
descriptor는 `harness/pi-runtime/features/tool-policy/feature.mjs#toolPolicyFeature`, staged runtime
import는 `rubato-features/tool-policy/index.mjs`다. Pi core patch나 Senpi runtime fallback은 없다.

전체 등록 순서는 다음을 유지해야 한다.

```text
loop guard -> hooks -> permission -> apply_patch -> other tools -> bash timeout -> terminal -> tool-pair guard
```

앞의 blocking handler가 뒤 handler와 실제 tool 실행을 막는 stock `ExtensionRunner` 의미를 이용한다.
따라서 hooks가 막은 호출은 permission prompt에 도달하지 않고, permission이 허용한 bash 입력은
bash-timeout 보정 뒤 terminal tool이 실행한다.

## 구현 계약

| 기능 | 현행 근거 | stock 연결과 선택한 경계 |
| --- | --- | --- |
| command hooks | 현행은 command hook을 병렬 실행한 뒤 선언 순서로 block/ask/allow와 output replacement를 합친다(`Senpi dist/core/extensions/builtin/hooks/dispatcher.js:7-69,123-192`). 기본 timeout은 600초, 최소 환경만 상속하고 process group을 종료한다(`hooks/safety.js:5-56`, `command-runner.js:6-91`). stdout/stderr는 각각 64KiB로 제한하고 redaction 후 spill한다(`hooks/output-bounds.js:6-41`). | `createHooksExtension`은 실제 child process, JSON stdin, platform command, timeout/AbortSignal, process-group kill, bounded capture와 spill을 소유한다. `PreToolUse`는 exit 2의 private stderr를 노출하지 않고 block하며, 명시적 allow에서만 `updatedInput`을 적용한다. `PostToolUse`는 선언 순서의 마지막 replacement와 pre/post context를 stock `tool_result`로 되돌린다. |
| hook lifecycle | 현행 공개 연결은 `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`이다(`hooks/index.js:39-207`). prompt context/system message, compaction cancel, Stop follow-up와 8회 reentry 제한이 포함된다. | 같은 일곱 event를 stock `session_start`, `input`/`before_agent_start`, `tool_call`/`tool_result`, `session_before_compact`/`session_compact`, `agent_end`에 연결했다. stock 0.85.1에는 compaction request ID/accepted 필드가 없으므로 adapter가 session-local ID를 만들고 성공 event를 `accepted:true`로 표현한다. `sendFollowUp`을 주입하지 않으면 공개 `pi.sendUserMessage(..., {deliverAs:"followUp"})`를 쓴다. |
| hook trust/discovery | 현행은 global/project/settings/plugin/pre-session/runtime source를 합치고 command hash, enabled bit, project trust와 `/hooks` UI를 별도 저장한다(`hooks/index.js:16-37,208-223`, `hooks/trust.js:4-99`). | 실행 모듈은 discovery/trust 저장소를 가장하지 않는다. `resolveSources(ctx)`가 ordered source를 반환하고 각 source는 `trusted:true`이거나 `isTrusted(handler,ctx)`를 통과해야 한다. adapter가 없거나 untrusted면 실행하지 않고 `hook_diagnostic`을 emit한다. 기본 discovery는 명시한 `agentDir/hooks.json`과 `<cwd>/.senpi/hooks.json`만 읽는다. |
| permission | 기본은 `full-access`; `workspace`, `read-only`, `ask` preset과 last-match-wins wildcard를 쓴다(`permission-system/config.js:3-25`, `evaluate.js:2-12`). 설정 우선순위는 default -> global preset/rules -> project preset/rules -> CLI preset/rules다(`settings.js:5-28`). no-UI ask는 auto-deny하고 interactive UI는 once/always/deny/feedback을 제공한다(`non-interactive.js:2-41`, `prompt.js:1-23`). | `createPermissionExtension`이 두 CLI flag, preset/rule 평가, hard-deny tool 비활성화, 실제 `tool_call` veto, no-UI deny, stock UI 선택지, session `always` rules와 shutdown persistence를 연결한다. `resolveSettings(ctx,pi)`는 `{preset?,rules?,approved?}`를 반환하고, 여러 settings scope가 있으면 `rules`를 낮은 우선순위부터 이미 flatten해야 한다. `persistApproved(ctx,rules)`가 durable storage owner다. |
| permission parsing | bash/bash_input의 사람이 읽을 수 있는 prefix, edit/apply-patch paths, read/grep/find/ls, external directory, monitor를 각각 같은 permission class로 바꾼다(`permission-system/arity.js:1-164`, `parsers.js:74-195`). | 현행 command arity table과 path parser를 보존했다. `monitor.path`는 read, `monitor.command`는 bash로 gate한다. terminal이 요구하는 canonical approved-parent marker는 `prepareMonitorInput(input,ctx)` adapter가 붙인다. 미등록 tool은 tool 이름의 `*` permission으로 fail-closed한다. |
| bash timeout | default/max 1800초이며 env override에서 max를 default 이상으로 올린다. missing/nonpositive만 default로 채우고 explicit 값은 보존한다(`bash-timeout/timeout.js:1-31`). native Anthropic bash일 때는 PTY auto-detach 문구를 넣지 않는다(`bash-timeout/index.js:19-32`). | `createBashTimeoutExtension({env,resolveForegroundWindowSeconds,isAnthropicBashEnabled})`가 stock `tool_call` input을 in-place 보정하고 `before_agent_start` system prompt를 합성한다. timeout은 process kill deadline이며 terminal foreground window와 구분한다. |

Senpi-origin source의 MIT attribution과 license는
`harness/pi-runtime/features/tool-policy/THIRD_PARTY_NOTICES.md`에 포함했다.

## 공개 factory 인터페이스

```js
createHooksExtension({
  agentDir,
  resolveSources,       // async (ctx) => [{sourcePath,scope,displayOrder,config,...}]
  isTrusted,            // async (handler, ctx) => boolean
  runCommand,           // optional test/host runner override
  sendFollowUp,         // optional async (text, ctx), default pi.sendUserMessage
  resolvePermissionMode,
  envPassthrough,
  sourceEnv,
  outputPolicy: { maxStdoutBytes, maxStderrBytes, spillDir },
});

createPermissionExtension({
  resolveSettings,      // async (ctx, pi) => {preset?, rules?, approved?}
  requestApproval,      // optional; default stock ctx.ui or no-UI reject
  persistApproved,      // async (ctx, addedRules) => void
  prepareMonitorInput,  // optional terminal canonical-parent adapter
});

createBashTimeoutExtension({
  env,
  resolveForegroundWindowSeconds,
  isAnthropicBashEnabled,
});
```

세 factory는 각각 별도 extension factory로 등록해야 한다. grouped factory 하나로 등록하면 root가
apply_patch와 terminal 사이에 bash-timeout을 놓거나 loop/hooks/permission의 veto 순서를 보존할 수 없다.

## 실제 검증

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE node --test --test-timeout=120000 \
  harness/pi-runtime/features/tool-policy/tool-policy.test.mjs
```

테스트는 runtime을 stage한 뒤 실제 stock `DefaultResourceLoader`, `createAgentSession`,
`ExtensionRunner`와 generic executor를 사용한다. 격리된 임시 hook subprocess만 실행하며 live hook,
profile, credential, provider 요청은 쓰지 않는다. 다음 경로를 고정한다.

- trusted Pre/Post hook input mutation, result replacement/context, exit-2 veto
- UserPrompt context/system message, PreCompact cancel, PostCompact dispatch, Stop follow-up
- read-only no-UI deny, ask/always approval 재사용과 shutdown persistence
- bash env default/max 선택, missing timeout mutation, explicit timeout 보존, detach prompt
- 실제 장기 child timeout의 process-group 종료와 hang 없음

## 정확히 남은 경계

- root bootstrap은 current settings/plugin/pre-session source와 command-hash trust storage를
  `resolveSources`/`isTrusted`에 연결해야 한다. 지금 기본 두 JSON 파일만으로 전체 discovery parity를
  주장하면 안 된다.
- `/hooks` trust/status UI, running-hook status label, plugin `${PLUGIN_ROOT}` target containment,
  Senpi 전체 sensitive-output redactor와 invalid JSON/regex의 세부 diagnostic shape는 아직 없다.
- Stop 8회 제한은 session memory에만 있고 Senpi custom-entry 기반 reload/branch persistence와 output
  diagnostic renderer는 아직 없다.
- permission `always` durable file format과 global/project settings loader는 host adapter 소유다.
  동시 pending request에서 한 `always`가 covered sibling을 자동 resolve하고 한 reject가 같은 session의
  sibling을 모두 reject하는 Senpi service 동작은 아직 이 작은 extension에 없다.
- `prepareMonitorInput`이 없으면 monitor 호출 자체의 read/bash permission은 적용되지만 terminal의
  canonical-parent marker는 생기지 않는다. bootstrap은 이를 silent success로 취급하면 안 된다.
- command hooks의 specialized TUI progress/status와 permission dialog의 Senpi custom renderer는 stock
  기본 UI로 대체되어 있다. 실행 결정은 보존됐지만 화면 픽셀 parity 증거는 아니다.
