# Stock Pi codemode 이관 경계

결론: codemode는 Pi package 내부 patch가 아니라 독립 runtime feature다. 선택된 runtime의
`rubato-features/codemode/`에 source와 worker/interpreter asset 99개를 함께 stage한다.
이 위치에서 `typebox@1.3.18`과 `@babel/parser@8.0.4`를 runtime root dependency로
고른다. coding-agent 아래에 넣으면 Pi가 내부에서 쓰는 `typebox@1.3.7`이 선택되므로
같은 코드가 다른 schema runtime으로 실행된다.

## 보존한 구현과 provenance

기준 source는 `@code-yeongyu/senpi-codemode@2026.9.4-3`의 published runtime `src`다.
원본 checkout의 bun lock에 기록된 package SRI는
`sha512-DX0Sf6/S5Ez8AeIAzAJyYxrAUAFmDhQ+FP+KxXw+RmLwJfX/cxzktiUcm3v89zR1xHDuiPkCDWQMHGhA5uM1OQ==`다.
MIT 원문을 `features/codemode/LICENSE`에 복제했고 SHA-256은
`b572487f123bf259487f7dab25923af16fecd08ed7a2c50964f393282dba883c`다.
세부 출처와 수정 범위는 같은 디렉터리의 `THIRD_PARTY_NOTICES.md`가 기록한다.

다음 재귀 자산을 source와 함께 stage한다.

- JS: `worker-entry.js`, `inline-worker-entry.js`, `worker-core.js`,
  `worker-runtime.js`, `worker-indirect-eval.js`, `worker-shell-capture.js`
- Python: `prelude.py`
- Ruby: `runner.rb`, `prelude.rb`
- Julia: `runner.jl`, `prelude.jl`
- bridge, kernel/session/detach manager, output/render/settings/completion source 전체
- `skill/bun-1-4/SKILL.md`와 references 전체

upstream의 `src/kernels/AGENTS.md`, `src/tool/AGENTS.md`는 contributor용 작업 지시문이며
실행 source나 asset이 아니어서 stage와 Git 이식 목록 모두에서 제외했다.

`patches.mjs`의 `feature` export는 이 파일들을 절대 source path와
`target: "runtime"`으로 열거한다. stager는 feature id와 같은
`rubato-features/codemode/` namespace 밖으로 쓰지 못하고 receipt에 각 SHA-256과 owner를
남긴다. 원본 checkout이나 설치된 Senpi package를 runtime fallback으로 읽지 않는다.

## stock host 연결

모든 `@code-yeongyu/senpi` import를 local `host-sdk.ts`로 모았다. 여기서 runtime root의
direct `@earendil-works/pi-coding-agent`를 import하고, 그 실제 package directory 아래의
nested `pi-ai/dist/compat.js`를 선택한다. global/HOME/Senpi alias fallback은 없다.

stock `pi-tui@0.85.1`에는 기존 codemode가 쓰던 `sanitizeTerminalLabel` export가 없다.
이 한 함수는 Senpi TUI의 짧은 MIT 구현을 그대로 local 보존했다. 나머지 image, truncation,
tool definition, highlight, render helper는 stock coding-agent 공개 root export를 사용한다.

eval 내부 `tool.<name>()`은 MCP나 registry를 직접 부르지 않는다. 기존 Rubato adapter의
`createExecuteTool(pi)`가 일반 host API를 다음처럼 호출한다.

```ts
pi.executeTool(name, rawParams, {
  signal,
  onUpdate,
  activateInactiveTool: true,
})
```

inactive activation 자격, argument validation, permission/preflight, `tool_call`/`tool_result`
hooks는 host core가 소유한다. codemode는 `pi.getAllTools()`를 schema catalog로 쓰고
`getActiveTools()`를 availability에만 쓴다.

stock Pi에는 Senpi의 `registerRemovedToolHint`가 없다. 이를 optional no-op으로 버리지 않고
local `stock-host-adapter.ts`가 `context` hook에서 stock의 정확한
`Tool <name> not found` 결과에 등록된 안내를 붙인다. 따라서 다음 provider request가 보는
`exec`/`wait` redirect는 보존된다. Senpi native API가 있는 host에서는 native registrar를
그대로 사용한다. 다만 stock TUI/session에 저장되는 최초 오류 문자열 자체는 hint 전 상태다.

## 합친 Rubato 동작

- `src/index.ts`: session start마다 manager/runtime/cell owner를 새로 만들고,
  shutdown/switch/fork에서 detached cell, kernel, bridge를 모두 정리한다. model 변경에는
  같은 runtime의 eval definition만 다시 등록한다. 최신 upstream의 foreground-window,
  monitor discovery, Bun skill/runtime 표기도 유지한다.
- `src/extension/eval-notifier.ts`: detached completion을 synthetic user turn으로 만들지 않고
  보이지 않는 custom message로 한 번만 steer/follow-up 한다.
- `src/prompt/eval-prompt.ts`: ordinary single calls는 direct tool, programmatic intermediate와
  persistent 계산은 eval이라는 한 규칙으로 통일한다. 기존 모델별 eval 강제 문구는 넣지 않는다.

## 실행 증거

```text
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE \
  node --test --test-timeout=30000 \
  harness/pi-runtime/features/codemode/codemode.test.mjs \
  harness/pi-runtime/features/codemode/codemode-interpreters.test.mjs

7 tests: 6 pass, 1 skip (Julia executable 없음)
```

테스트 순서는 다음 계약을 고정한다.

1. source/worker/prelude/runner/skill/MIT 자산 존재와 Senpi runtime import 부재
2. clean stage에 99개 runtime-owned file 추가, staged entry 실제 import,
   root `typebox@1.3.18`/`@babel/parser@8.0.4` 선택
3. staged stock `DefaultResourceLoader`/`AgentSession`에 codemode default factory를 실제 bind,
   `42` 뒤 `7`을 읽는 persistent JS와 inactive `echo`의 same-turn lazy activation 1회 확인
4. 별도 JS lifecycle에서 첫 cell `saved = 41`, 두 번째 cell `42`로 같은 worker state 확인
5. cell 안 `tool.echo({value: saved})`가 generic executor로 들어가며
   `activateInactiveTool: true`, AbortSignal, eval update와 성공 summary를 보존
6. 무한 cell만 별도 50ms foreground definition으로 detach한 뒤 peek → stop,
   cancellation과 state reset, completion notification 정확히 한 번 확인
7. cell manager와 session manager dispose 뒤 기존 worker의 새 run이 `closed`로 거부되고
   HTTP bridge endpoint도 사라지는지 확인
8. Python 3.14.6 실제 subprocess에서 `saved=41` 뒤 `42`, HTTP `tool.echo`, SIGINT 뒤
   state retained, close 뒤 캡처한 PID 소멸 확인
9. Ruby 2.6.10 실제 subprocess에서 같은 persistence/tool 계약, interrupt 때 기존 process를
   retire하고 새 process로 교체해 state가 사라지며 모든 캡처 PID가 소멸하는지 확인
10. Bun 1.4.0 프로세스 안에서 실제 JS worker의 persistence/tool reply/interrupt/state reset을
    확인하고 worker close 뒤 Bun host process까지 종료되는지 확인

모든 실행은 local temporary cwd, fake generic tool 하나와 실제 Worker/HTTP bridge/subprocess를
사용했다. `NODE_OPTIONS`와 `NODE_COMPILE_CACHE`는 비웠다. provider 호출, user profile,
MCP 우회는 없었다.

## 아직 완료되지 않은 경계

- Julia runner는 이 host에 executable이 없어 명시적으로 skip했다. source/asset 포함은
  Julia runtime parity 증거가 아니다.
- Python/Ruby/Bun은 위의 실제 프로세스 계약까지 통과했지만, Windows 및 Linux에서 같은
  interpreter/process-group 종료를 실행하지 않았다.
- stock removed-tool adapter는 다음 provider context에 붙는 redirect를 검증했지만,
  Senpi처럼 최초 오류를 TUI와 session 저장값에도 즉시 넣는 core-native API는 없다.
- image/render/TUI와 provider-backed completion은 실행하지 않았다.

따라서 현재 증거는 **독립 배포 가능한 codemode source/assets, 실제 patched stock SDK bind,
Node/Python/Ruby/Bun eval·tool·interrupt·shutdown**까지다.
Julia와 다른 OS, TUI/provider-backed completion까지 실행하기 전에는 전체 codemode
parity나 기본 엔진 전환 완료로 표시하면 안 된다.
