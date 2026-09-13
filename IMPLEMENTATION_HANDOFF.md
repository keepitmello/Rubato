# IMPLEMENTATION_HANDOFF

## 1. 작업 목적

Rubato의 두 실행 경로를 모두 유지하면서 제품 수준에 가깝게 완성한다.

```text
Codex Desktop → Codex app-server/runtime → rubato-codex → Rubato Core semantics
T3 Desktop/Web → Rubato/Pi provider → Pi server/session layer → rubato-pi → Rubato Core
```

이번 변경은 `rubato-codex`를 최신 공개 Codex 구현과 비교해 실제 중복/오류만 최소 수정하고, `rubato-pi`에는 공식 Pi server/session primitives를 이용한 다중 세션 host를 추가한 뒤 T3를 비소유 presentation/control surface로 연결한다. canonical runtime은 결정하지 않는다.

## 2. 확정된 설계

- Codex Desktop/app-server/runtime은 그대로 소유권을 유지한다. Agents API나 별도 실행기로 재작성하지 않는다.
- Rubato Taskforce 작업보드는 대화/session 저장소가 아니다. Codex native agent lifecycle과 분리해서 유지한다.
- Pi 0.85.1의 public `Server`, `SessionRouter`, `Client`, Chord, Unix transport를 재사용한다.
- Pi 저장 대화는 기존 JSONL/`SessionManager`가 source of truth다. 목록을 보는 것만으로 worker를 만들지 않는다.
- 저장 session, live runtime, presentation attachment를 서로 다른 식별자로 유지한다.
- `running + no attachment`는 turn 완료 전 임의 unload하지 않는다. `idle + no attachment`만 idle 정책으로 정리할 수 있다.
- 실제 worker는 기존 `harness/rubato-pi/bin/rubato-pi.mjs --mode rpc` 경로를 사용한다. Pi core fork나 두 번째 모델 runtime을 만들지 않는다.
- T3는 기존 `ProviderDriver`, `ProviderSessionDirectory`, project/thread command/projector를 재사용한다. 별도 Pi DB나 worker manager를 만들지 않는다.
- T3 stop/Scope 종료는 presentation detach일 뿐 Pi worker 종료가 아니다. abort만 실행 중 turn을 중단한다.
- T3 integration은 고정 upstream commit과 직접 수정하는 두 파일의 SHA-256을 확인하는 guarded overlay로 유지한다. upstream이 바뀌면 임의 적용하지 않는다.
- 실제 대응 정책이 없는 T3 plan/approval modes를 가장하지 않는다. 현재 Rubato provider는 `full-access`만 허용한다.
- 두 제품의 성능/사용감 비교가 끝나기 전 canonical runtime을 선택하지 않는다.

## 3. 변경 파일

주요 변경은 다음과 같다.

- `.github/workflows/dual-runtime-ci.yml`: Pi/Codex/T3 자동 검증과 재현 산출물 보존.
- `rubato-codex/bundle-dependencies.json`, `rubato-codex/test/skills-bundle.test.mjs`: Codex 감사에서 확인한 두 최소 수정.
- `harness/pi-server/src/contracts.mjs`: Rubato가 노출하는 server/session/control 서비스 계약.
- `harness/pi-server/src/session-files.mjs`: public SessionManager 기반 저장 목록/생성/읽기 adapter.
- `harness/pi-server/src/rpc-worker.mjs`: 기존 `rubato-pi --mode rpc` 프로세스를 official server runtime handle 뒤에 연결.
- `harness/pi-server/src/host.mjs`: official Pi Server/SessionRouter와 Rubato worker lifecycle 연결.
- `harness/pi-server/src/client.mjs`: presentation client, attach/detach/reconnect/subscribe/reply 경계.
- `harness/pi-server/src/profile-server.mjs`, `src/cli.mjs`, `src/worker-parent.mjs`: 프로필당 서버 하나, 주소/잠금/부모 종료 경계.
- `harness/pi-server/test/**`: 저장 100개, 다중 client, detach/reattach, abort, 질문, 재시작, 프로세스 오류, snapshot 순서, disconnect cleanup 검증.
- `harness/pi-server/scripts/measure-lifecycle.mjs`: 모델 비용 없이 session control path를 반복 계측하는 경로.
- `harness/t3-integration/apply.mjs`, `upstream.json`: guarded/reversible T3 overlay.
- `harness/t3-integration/overlay/.../RubatoPiDriver.ts`: T3 provider driver.
- `harness/t3-integration/overlay/.../RubatoPiInventory.ts`: 저장/live Pi session을 기존 T3 project/thread/binding으로 투영.
- `harness/t3-integration/src/bridge.mjs`: Pi presentation attach, command, event, reconnect, detach 경계.
- `harness/t3-integration/src/events.mjs`: Pi event → T3 provider event 정규화와 reconnect 중복 방지.
- `harness/t3-integration/test/**`: overlay, 실제 T3 driver factory, inventory/decider/projector, live attach/reconnect/event 검증.
- `docs/dual-runtime/**`: Codex 감사, Pi 채택표, T3 구조/검증, 체크포인트, 성능 측정 절차.

## 4. 구현 내용

Codex 경로는 독립 session manager나 대체 runtime을 찾지 못했다. Taskforce board는 작업 상태만 저장하고 Codex가 thread/turn/agent 수명주기를 계속 소유한다. 실제 수정은 `work-intent` 의존성 manifest 누락과 과거 스킬 개수를 하드코딩한 시험뿐이다.

Pi 경로는 official server/router가 session handle 중복을 막고 attachment 주소를 관리한다. Rubato host가 저장 session에서 기존 RPC worker를 필요할 때만 열며, presentation detach와 worker lifecycle을 분리한다. 저장 목록과 transcript는 runtime을 hydrate하지 않는다.

T3 경로는 `resumeCursor = {kind:"rubato-pi", serverId, sessionId}`로 durable mapping을 남긴다. idle 저장 session은 sidebar/project/thread에 보이지만 실행기를 띄우지 않고, 이미 running인 session은 기존 runtime에 attach한다. 새 session, prompt/steer, abort, text/reasoning/tool events, 질문/확인, reconnect, 외부 inventory update를 처리한다. reconnect snapshot은 이미 표시된 assistant 본문 뒤의 delta만 이어서 출력한다.

강제 연결 끊김에서 자동 reconnect와 수동 reconnect가 겹치는 경쟁 상태를 통합시험에서 발견했다. 현재 구현은 reconnect 호출을 하나의 Promise로 직렬화하고, 같은 Pi socket이면 official client `reconnect()`로 같은 presentation object를 재사용한다. socket 주소가 실제로 바뀐 경우에만 이전 presentation 연결을 버리고 새 client를 만든다.

## 5. 아직 실행하지 못한 검증

- macOS 실제 Codex Desktop 앱에서 설치/서명/자동 업데이트를 포함한 수동 smoke.
- 실제 T3 Desktop/Web UI에서 sidebar 표시, 새 thread 생성, session 전환, background 상태 배지의 사람 손 검증.
- 실제 사용자 모델 인증으로 OpenAI/Anthropic/xAI 등 외부 모델 호출.
- 실제 모델의 first event/first token latency와 여러 active session의 전체 프로세스 RSS/CPU 비교.
- `RUBATO_TEST_CANDIDATE`를 새 CI run에서 직접 빌드·주입하는 smoke. 과거 로컬 checkpoint에서는 실제 Rubato candidate의 session/snapshot/get_commands 경계까지 통과했지만 현재 기본 CI에서는 환경 변수가 없어 1개 검사를 건너뛴다.
- 서버 프로세스 자체를 SIGKILL하는 별도 통합시험. 저장 session restart/resume과 child invalid-output 강제 정리는 검증했지만 OS-level crash matrix 전체를 완료했다고 보지 않는다.

## 6. 로컬 검증 절차

Node 24 이상을 사용한다.

```sh
npm --prefix harness/pi-server install --ignore-scripts --workspaces=false
npm --prefix harness/pi-server test --workspaces=false
node harness/pi-server/scripts/measure-lifecycle.mjs
```

Codex 감사 회귀:

```sh
node --test --test-timeout=45000 \
  rubato-codex/test/skills-bundle.test.mjs \
  rubato-codex/test/bundle-dependencies.test.mjs \
  rubato-codex/test/prompts.test.mjs \
  rubato-codex/test/providers.test.mjs \
  rubato-codex/test/package.test.mjs \
  rubato-codex/test/opencodex-setup.test.mjs
```

T3는 `harness/t3-integration/upstream.json`의 commit을 정확히 준비한 뒤 적용한다.

```sh
node harness/t3-integration/apply.mjs --t3 /absolute/path/to/t3code
T3_SOURCE=/absolute/path/to/t3code \
  node --test --test-timeout=90000 harness/t3-integration/test/*.test.mjs
pnpm --dir /absolute/path/to/t3code --filter t3 typecheck
pnpm --dir /absolute/path/to/t3code --filter t3 build:bundle
```

실제 Rubato candidate smoke를 추가하려면 현재 Rubato Pi candidate를 빌드하고 `RUBATO_TEST_CANDIDATE=/absolute/candidate`로 Pi server test를 실행한다. 실제 모델 검증은 같은 모델/추론 강도/입력을 Codex와 T3/Pi 양쪽에서 맞춘 뒤 `docs/dual-runtime/PERFORMANCE_MEASUREMENT.md` 절차를 따른다.

## 7. 성공 조건

- Codex 감사 회귀: 실패 0. 현재 자동 검사 기준 37개 중 36 통과, 실제 Codex binary 검증 1개 건너뜀.
- Pi server: 저장 100개 목록 조회 뒤 runtime 0개, running A detach → B 사용 → A reattach에서 동일 runtime, 질문/abort/restart/cleanup 검증 실패 0. 현재 자동 검사 기준 10개 중 9 통과, candidate 1개 건너뜀.
- T3: provider/inventory 통합시험 전부 통과. 현재 7/7 통과.
- 현재 고정 T3 upstream에서 전체 server typecheck와 server bundle build 통과.
- PR의 `pull_request` workflow가 최신 `rubato/base`와 합쳐진 merge ref에서도 위 검사를 통과.
- 실제 로컬 제품 smoke에서 T3를 닫거나 다른 thread로 이동해도 background Pi 작업이 중단되지 않고, 돌아왔을 때 중복 worker/중복 출력 없이 이어진다.

## 8. 주의할 부분

Pi server와 T3 upstream은 아직 빠르게 변한다. 특히 `upstream.json`이 가리키는 T3 두 삽입 파일의 해시가 바뀌면 overlay를 억지 적용하지 말고 새 upstream 계약을 조사한다.

Pi server는 자신이 시작한 worker만 소유한다. 기존 별도 TUI 프로세스의 stdio를 탈취해 이 server에 입양하는 기능은 없다. 같은 Pi server가 이미 소유하는 live session에는 여러 presentation client가 붙을 수 있다.

자동 성능 수치는 결정적 fixture worker와 CI VM에서 얻은 control-path 자료다. 모델 추론 속도나 전체 제품 우열로 해석하면 안 된다.

T3의 provider environment 설정을 독립 Pi server에 조용히 주입하지 않는다. 실제 외부 인증은 Rubato/Pi가 소유하는 기존 설정 경로를 따른다.

## 9. 로컬 에이전트의 수정 권한

로컬 검증 중 발견되는 단순 구현 오류, 형 오류, 이름/경로 차이, upstream의 사소한 계약 이동, 기존 코드와의 좁은 통합 문제, 시험 실패는 이 문서의 확정 설계를 바꾸지 않는 범위에서 직접 수정하고 다시 검증해도 된다.

다음 문제가 나오면 임의로 새 설계를 선택하지 않는다.

- Codex Desktop/runtime을 교체해야만 해결되는 문제
- Pi session/runtime/presentation의 소유권 경계를 바꿔야 하는 문제
- 기존 Pi JSONL 대신 별도 대화 저장소가 필요한 문제
- T3 core 장기 fork나 두 번째 worker/session manager가 필요한 문제
- Rubato Taskforce/모델/메모리/스킬 의미론을 바꿔야 하는 문제
- 선택한 Pi/T3 public API로 핵심 수명주기를 만족할 수 없음이 실제 실행에서 확인된 경우
- 여러 제품/구조 대안 중 다시 사용자 판단이 필요한 경우

그 경우 구현을 억지로 계속하지 말고 다음을 남겨 설계 검토로 돌린다: 문제가 발생한 위치, 재현 방법, 기대 결과, 실제 결과, 기존 설계가 실패하는 이유, 영향 범위, 확인된 대안, 다시 필요한 설계 판단.
