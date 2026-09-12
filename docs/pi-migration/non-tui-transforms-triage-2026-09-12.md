# 비-TUI 트랜스폼 43개 대체 여부 판정 (2026-09-12)

`transforms-classification.md` 의 "Inspected, not TUI/input/display (dropped)" 절이 분류에서
뺀 트랜스폼들을 stock-pi 현행 feature 와 stock 0.85.1 dist 에 대조해 판정한 장부다.
코드는 바꾸지 않았다. 판정만 한다.

## 목록 확정 (43개)

`harness/rubato-pi/src/transforms/` 실제 파일 75개에서

- 분류표 본문 26행 (tui-chrome, control-interactive-mode, control-slash-commands,
  interactive-mode-chrome, tool-group-component, turn-work-summary, working-phase,
  assistant-message/-descriptors/-phase, core-descriptors, tool-execution, internal-actions,
  transcript-cache, misc-tui-autocomplete, misc-model-selector, misc-thinking-levels,
  core-session-list-page, boot-perf/-interactive-defer/-main-defer/-loader-defer/-catalog-slim/
  -agent-session-export, misc-high-reasoning, core-error-format)
- frozen 2개 (core-session, core-prompt-noise)
- 공용 헬퍼/디스패처 4개 (core-replace, replace-once, misc-replace, misc-vendor)

를 빼면 정확히 43개가 남는다. 아래 표의 43행이 그것이다.

## 판정 기준

- **대체됨** = feature 디렉터리에서 같은 동작을 하는 코드를 찾아 행 번호로 인용한 것만.
- **불필요** = 패치 대상 자체가 stock 0.85.1 에 없고(senpi 전용 파일/함수), 그 동작이 상류에서
  사라졌거나 애초에 senpi 구조를 고치던 것.
- **대체 없음** = 대상이 stock 에 그대로 있고(또는 동작이 여전히 필요하고) feature 에 대응 코드가 없다.
- **미확인** = 판단에 필요한 증거를 이번에 확보하지 못했다. 무엇을 봐야 하는지 적었다.

경로 약칭: `F/` = `harness/pi-runtime/features/`,
`S/` = `harness/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/`,
`SAI/` = 그 안의 `node_modules/@earendil-works/pi-ai/dist/`.

## 표

| # | 트랜스폼 | 옛 동작 | 현재 상태 | 사용자에게 보이는 차이 |
|---:|---|---|---|---|
| 1 | control-codemode | senpi-codemode(jiti src/*.ts) 로더/러너/슬래시/인터랙티브 주입 클러스터 | **불필요** — 대상 vendor(senpi-codemode) 자체가 없고 codemode 가 정식 feature 로 기본 활성 (`feature-catalog.mjs:8`, `F/rubato-components/candidate-main.mjs:9`) | 없음 |
| 2 | control-codemode-redirect | jiti 가 fs 로 읽는 senpi-codemode 엔트리를 in-repo 패치본으로 리다이렉트 | **불필요** — 같은 이유. codemode 소스를 feature 가 직접 소유 (`F/codemode/src/index.ts`) | 없음 |
| 3 | control-extensions | senpi `extensions/loader.js`·`runner.js` 에 원격 UI 브리지/도구결과 배선 주입 | **부분 대체됨** — runner 쪽은 `F/provider-execution/patches.mjs:289-292` (`dist/core/extensions/runner.js`) 가 소유. loader 쪽 주입은 A16 원격 전용이라 대체 없음(범위 밖) | 로컬 TUI 없음 |
| 4 | core-agent-session | ① 줄 중간 `$skill:`/`/skill:` 인라인 확장 ② user abort 후에도 필요한 compact 실행 ③ eval-only 직접도구 유지 | **대체 없음** — stock `S/core/agent-session.js:984` 는 `text.startsWith("/skill:")` 선두 전용이고 `INLINE_DOLLAR_SKILL_INVOCATION_PATTERN`·`userAbortSuppressedQueuedContinuation` 은 features 전체에 없음. `F/provider-execution/patches.mjs:297-300` 이 같은 파일을 패치하지만 after-tool-call 용도로 다른 동작 | ② Esc 로 턴을 끊으면 필요한 compact 가 건너뛰어져 다음 프롬프트까지 창이 넘친 채 남을 수 있음 |
| 5 | core-compaction | 요약 응답이 tool call 로 오면 1회 제한 재시도 후 결정적 폴백 요약(원문 head+tail 보존) | **대체 없음** — `fallbackCharBudget`/폴백 마커가 features 전체에 없음 | 컴팩션이 tool call 응답을 받으면 계속 실패(accepted:false)로 남을 수 있음 |
| 6 | core-compaction-policy | 임계 비율·reserve·adaptive threshold·설정 해석 | **대체됨** — `F/compaction/policy.mjs:19,49,70,80,85,92`, `F/compaction/threshold.mjs:26-29` | 없음(수치 동등성은 미확인) |
| 7 | core-compaction-prune | `buildCompactionContext` 파이프라인 + Cursor thinking strip + overflow-retry | **대체 없음** — `stripCursorThinking` 이 features 에 없고 대상 `context-pipeline.js` 는 stock 에 없음. 대신 stock 기본 파이프라인이 돈다 | Cursor 세션에서 컴팩션 입력에 thinking 이 남아 요약 품질·토큰이 달라질 수 있음 |
| 8 | core-compaction-utils | 요약 시스템 프롬프트를 `<summary></summary>` 강제로 바꾸고 thinking 직렬화 조정 | **대체됨** — `F/compaction/patches.mjs:40-41` 이 stock `compaction/utils.js` 의 `SUMMARIZATION_SYSTEM_PROMPT` 임포트 지점을 패치 | 없음(프롬프트 문구 동등성은 미확인) |
| 9 | core-context-notes | 컨텍스트 노트 소유권 게이트 + 요약 메시지·레인 판정 | **대체됨** — `F/context-notes/patches.mjs:15-27` (checkpoint/controller/engine-gate 등 11개 소스), `F/context-window/` | 없음 |
| 10 | core-empty-recovery | pi-agent-core `withEmptyAssistantRecovery` 버퍼링 중에도 stream-start 감시에 "살아있음" 응답 | **불필요** — stock pi-agent-core 0.85.1 `dist/` 에 `empty-assistant-recovery.js` 가 없고 `agent-loop.js` 에 stream-start 타임아웃 문자열도 없음 | 없음(대상 메커니즘 소멸) |
| 11 | core-lane-policy | Anthropic 서버 컴팩션 모델을 "외부 소유" 레인으로 선언해 클라이언트 요약 우회 | **대체됨** — `F/compaction/extension.mjs:51` `rejectionCause:"external-owner"` + `F/compaction/anthropic-server-compaction.mjs:18-22` 모델 id 단일 진실 | 없음 |
| 12 | core-messages | hidden custom 턴을 assistant 로 remap 해 "마지막 user" 를 뺏기지 않게 | **대체 없음** — `remapHiddenCustomTurns` 가 features 에 없고 stock `S/core/messages.js:89` 의 custom 분기는 그대로 | 컴팩션·메모리 notice 직후 모델이 사용자 말 대신 notice 에 답할 수 있음 |
| 13 | core-overflow | overflow 감지에서 Cursor `cacheRead` 를 빼 허위 overflow 제거 | **대체 없음** — stock `SAI/utils/overflow.js:141,150` 이 여전히 `message.usage.input + message.usage.cacheRead` | Cursor 모델에서 창이 안 찼는데 overflow·컴팩션이 발동할 수 있음 |
| 14 | core-retry-watchdog | senpi `provider-timeout-retry.js` 의 재시도 감시 해제 | **불필요** — 대상 파일이 stock 에 없음(`S/core/provider-timeout-retry.js` 부재) | 없음 |
| 15 | core-routine-settings | 라이브 적용 설정 키 저장이 TUI 핫리로드(세션 shutdown)를 일으키지 않게 | **대체됨** — `F/config-reload/routine-settings.mjs:5-19` `ROUTINE_SETTINGS_KEYS` | 없음 |
| 16 | core-service-tier | Anthropic fast mode(`speed:"fast"` + beta, Opus 5/4.8 한정) 및 tier 신원 유지 | **대체됨** — `F/service-tier/extension.mjs:7,18` (`fast-mode-2026-02-01`, `/^claude-opus-(?:5|4-8)/`) | 없음 |
| 17 | core-session-persist | 첫 user 메시지에 jsonl 을 만들어 세션이 사라지지 않게 | **대체됨** — `F/session-catalog/patches.mjs:41-48` "persist-first-user" 가 stock 의 `hasAssistant` 게이트를 `hasMessage` 로 교체 (stock 원본: `S/core/session-manager.js:742,1166-1170`) | 없음 |
| 18 | core-session-resume-budget | 큰 세션 resume 시 모델 사용가능성 게이트가 TUI 를 `process.exit(1)` 시키지 않게 | **불필요** — stock `S/core/sdk.js` 에 `assertModelUsable`·`handleFatalRuntimeError` 없음 | 없음(대용량 resume 실제 동작은 미확인) |
| 19 | core-speculative | senpi speculative cheap-reasoning override 제거 | **불필요** — 대상 `compaction/speculative.js` 가 stock 에 없음(원 주석도 "senpi 에 이미 함수 없음") | 없음 |
| 20 | core-stream-watchdog | 요약 스트림 max duration 600s | **불필요** — 대상 `S/core/compaction/stream-watchdog.js` 부재. 유사 보호는 `F/compaction/circuit-breaker.mjs:1-2` (3회/60s) | 없음 |
| 21 | core-terminal-routing | eval-only 라우팅 판정 + terminal 프롬프트·확장 문구 | **대체됨** — `F/terminal/src/extension.ts:4,425` `isEvalOnlyRouting`, `F/terminal/src/prompt.ts` | 없음 |
| 22 | core-tool-descriptions | `wrapToolDefinition` 안의 AgentTool description 문구만 슬림 교체 | **대체 없음** — features 에 slim description 코드 없음. 대상 `S/core/tools/tool-definition-wrapper.js` 는 존재하고 다른 feature 들이 이 파일을 다른 목적으로 패치 | 도구 설명이 stock 원문(더 김) → 프롬프트 토큰 증가 |
| 23 | core-tool-surface | ① 에디터 도구 1개만 모델에 노출 ② universal apply_patch ③ MCP attach 논블로킹 ④ MCP 이름 `mcp__` 규약 | **부분 대체됨** — ② `F/tool-guards/apply-patch.mjs:1-9`, ④ `F/mcp/compat.mjs:106-108`. ①③ 은 **미확인** (확인 지점: `F/tool-execution/patches.mjs` 의 도구 등록 목록, `F/mcp/service.mjs` 의 attach await 여부) | ③ 미대체면 첫 메시지가 MCP attach 를 기다리며 멈출 수 있음 |
| 24 | cursor-agent | vendor `cursor-agent.js` 체크포인트 캐시·세션 소유 eviction | **대체됨** — 패치 대신 파일 통째 벤더링: `F/providers/patches.mjs:239-259` `cursorOwnedTargets` + `F/providers/vendor/pi-ai/api/cursor-agent.js` | 없음 |
| 25 | cursor-conversation-rotation | 폐기된 conversation lineage 회전 기록 정리 | **대체됨** — `F/providers/vendor/pi-ai/api/cursor-conversation-rotation.js` (동 `patches.mjs:239-259` 로 설치) | 없음 |
| 26 | cursor-exec-bridge | journal 가드가 붙은 Cursor exec bridge 전면 재작성 | **대체됨** — `F/provider-execution/cursor-exec-bridge.mjs:9-18` | 없음 |
| 27 | cursor-exec-bridge-session | 세션 id 를 journal 이 키로 쓰는 durable lineage 로 승격 | **대체됨(형태 변경)** — 전용 파일 대신 lineage 키가 bridge·journal 에 내장: `F/provider-execution/cursor-exec-bridge.mjs:16`, `F/provider-execution/cursor-exec-journal.mjs:8,53` | 없음(lineageId 공급원 동등성은 미확인) |
| 28 | cursor-exec-journal | 서버 구동 도구 호출의 영속 실행 저널(중복 실행 방지) | **대체됨** — `F/provider-execution/cursor-exec-journal.mjs` | 없음 |
| 29 | cursor-host-mutation | Cursor write/edit 프레임의 빈 bytes 처리·경로 해석 | **대체됨** — `F/provider-execution/cursor-host-mutation.mjs` (bridge 가 `createNativeFileTool` 로 사용, `cursor-exec-bridge.mjs:10`) | 없음 |
| 30 | cursor-read-image | Cursor readResult 의 이미지 바이트를 텍스트로 뭉개지 않게 | **대체됨** — 같은 소스 파일을 feature 가 그대로 설치: `F/providers/patches.mjs:309-311` | 없음 |
| 31 | cursor-vendor | 위 cursor 계열 클러스터 디스패처 | **불필요** — 클러스터 적용기일 뿐 | 없음 |
| 32 | misc-adaptive-tool-turn-effort | 사고 없이 tool_use 로 시작한 턴에서 thinking 을 끄는 상류 분기를 비활성화 | **불필요** — stock `SAI/api/anthropic-messages.js` 에 `finalAssistantTurnStartsWithToolUse` 자체가 없음(상류에서 제거) | 없음 |
| 33 | misc-anthropic-compaction | Anthropic 서버 컴팩션(beta `compact-2026-01-12`) 와이어 어댑터 | **대체됨** — `F/compaction/anthropic-server-compaction.mjs:10-22`, `F/compaction/anthropic-server-compaction-wire.mjs:14` | 없음 |
| 34 | misc-astra-codex | Astra 중간 effort 변경을 `configuration_update` 마크로 넣어 프롬프트 캐시 접두를 보존 | **대체 없음** — `configuration_update` 가 features 어디에도 없음(`F/prompt-preset/` 는 gpt-6-n 프리셋·튜닝만) | Astra 에서 Shift+Tab 으로 effort 를 바꾸면 프롬프트 캐시가 깨져 비용·지연 증가 |
| 35 | misc-auth-storage | auth.json 을 temp+rename+fsync 로 원자적 교체 | **대체 없음** — stock `S/core/auth-storage.js:66,140` 이 `writeFileSync` 그대로, `F/providers/auth-pool/state-store.mjs:65` 도 동일 | 쓰기 중 크래시·디스크풀 시 자격증명 파일이 반쯤 쓰여 로그인 유실 가능 |
| 36 | misc-claude-code-version | Claude Code 신원 문자열 2.1.251 → 2.1.257 | **대체 없음** — stock `SAI/api/anthropic-messages.js:41` 이 `"2.1.251"` (Fable 5.1 하한과 같은 값이라 실질 영향은 낮음) | 현재로선 없음 |
| 37 | misc-codex-ws-cache-ttl | Codex WS 세션 소켓 idle TTL 5분 → 30분 + timer unref | **대체 없음** — stock `SAI/api/openai-codex-responses.js:630` 이 `5 * 60 * 1000` | Codex 계열에서 5분 쉬면 소켓 재수립 — 첫 응답 지연 |
| 38 | misc-google-input-guard | `model.input` 이 없을 때의 TypeError 방어(`?.`) | **대체 없음** — stock `SAI/api/transform-messages.js:20`, `SAI/api/google-shared.js:201` 이 여전히 `model.input.includes(...)` | input 메타가 없는 모델 항목에서 요청이 예외로 터질 수 있음 |
| 39 | misc-pi-ai-lazy | lazy 스트림이 내부 provider 스트림의 local-work 를 위임하게 | **부분 대체됨** — Cursor 경로는 `F/providers/cursor-lazy.mjs:46-48` 이 `hasPendingLocalWork` 위임. 일반 pi-ai `api/lazy.js` 경로는 대체 없음(`setLocalWorkDelegate` 없음) | Cursor 외 provider 에서 서버 구동 도구가 길어지면 유휴 판정될 수 있음(영향 범위 미확인) |
| 40 | misc-prompt-cache-ttl | GPT-5.6+ Responses·Codex 프롬프트 캐시 TTL 30분 적용 | **미확인** — stock 에 `SAI/utils/prompt-cache-ttl.js` 자체가 없고 retention 이 `openai-completions.js`·`openai-codex-responses.js` 로 옮겨감. 확인할 것: 그 경로의 retention 기본값과 GPT-5.6+ 분기 유무 | 미확인(없다면 캐시 만료가 빨라져 비용 증가) |
| 41 | misc-session-date | 동적 시스템 프롬프트의 `Current date:` 를 프로세스 수명 동안 고정 | **미확인** — stock 에 `core/dynamic-prompt/build.js` 가 없고 `Current date`·`toISOString().slice(0, 10)` 문자열도 못 찾음. 확인할 것: stock 이 시스템 프롬프트에 날짜를 넣는지, 넣는다면 턴마다 재생성하는지 | 미확인(재생성한다면 UTC 자정에 캐시 접두 무효화) |
| 42 | remap-hidden-custom-turns | (12번의 구현부) hidden custom 을 assistant 로 바꿔 user 앞에 배치 | **대체 없음** — features 에 해당 remap 없음 | 12번과 동일 |
| 43 | request-run-tracker | 요청-런 타임라인 추적(입력 기록·pending·중단 처리) | **대체됨** — 같은 소스 파일을 feature 가 설치하고 배선: `F/request-run/patches.mjs:5,52,409-410` | 없음 |

## 집계

| 판정 | 수 |
| --- | ---: |
| 대체됨 (부분 포함) | 18 |
| 대체 없음 | 13 |
| 불필요 | 10 |
| 미확인 | 2 |

## "대체 없음" 중 사용자가 체감할 만한 것 — 우선순위 5

1. **core-messages / remap-hidden-custom-turns** — 컴팩션·메모리 notice 뒤 모델이 사용자의 마지막 말 대신 notice 에 답한다. 한 번 걸리면 대화가 통째로 어긋나므로 체감이 가장 크다.
2. **core-compaction (tool-call 폴백)** — 요약 요청이 tool call 로 돌아오면 컴팩션이 영구 실패로 남을 수 있다. 실패하면 긴 세션이 창 넘침에서 못 빠져나온다.
3. **core-overflow (Cursor cacheRead)** — Cursor 모델에서 창이 차지 않았는데 overflow 로 판정돼 불필요한 컴팩션이 돈다.
4. **misc-astra-codex** — Astra 에서 effort 를 바꾸면 프롬프트 캐시 접두가 깨져 비용과 첫 토큰 지연이 오른다. Shift+Tab 을 자주 쓰는 사용에서 바로 느껴진다.
5. **misc-auth-storage** — 드물지만 실패 시 손해가 크다(자격증명 파일 파손 → 재로그인).

그 다음 줄(선정 밖): core-agent-session 의 abort-후-compact, misc-codex-ws-cache-ttl,
core-tool-descriptions, misc-google-input-guard.

## 이 판정의 한계

- 동작 동등성을 **정적 대조**로 판정했다. 실제 런타임 턴으로 검증한 항목은 없다.
- "대체됨" 중 6·8(compaction 수치·문구), 27(lineageId 공급원)은 코드 존재는 확인했고 수치·문구
  동등성까지는 확인하지 않았다.
- 23번 core-tool-surface 의 ①③ 과 40·41 번은 미확인으로 남겼다. 위 표에 확인 지점을 적었다.

