# T3 ↔ Rubato/Pi 통합

## 조사 기준

2026-09-13 최종 재확인한 T3 `main`은 `3138f5716098a331f9a7d4cfc1bcd07118967a83`다. 최초 구현 기준 `cfeaca41ae27bdf2c203158d378c87c7308fea2a` 이후 20개 커밋을 비교했다. 우리가 직접 삽입하는 `apps/server/src/provider/builtInDrivers.ts`와 `apps/server/src/serverRuntimeStartup.ts`는 그 사이 바뀌지 않았고, 현재 HEAD로 고정점을 올린 뒤 전체 통합시험·T3 server 형 검사·server bundle 빌드를 다시 실행했다.

T3의 기존 `ProviderDriver`, `ProviderSessionDirectory`, project/thread 명령 및 projector를 그대로 재사용한다. T3 안에 두 번째 Pi 대화 저장소나 worker manager를 만들지 않는다.

## 소유권

```text
T3
  = project/thread UI, provider binding, normalized presentation events

Rubato/Pi server
  = persisted Pi session, live runtime/worker, command/event source of truth
```

`ProviderSessionDirectory.resumeCursor`에 `{kind:"rubato-pi", serverId, sessionId}`를 보존한다. 화면 연결을 닫거나 T3 provider session을 stop해도 Pi worker를 중단하지 않는다. 실행기를 중단하는 명령은 명시적인 abort일 때만 보낸다.

## 구현

- `apply.mjs`: 고정한 T3 소스 두 지점의 SHA-256을 확인하고 provider overlay를 원자적으로 적용한다. 재적용은 멱등이며 제거 가능하다. 외부 수정이나 symlink가 있으면 덮어쓰지 않는다.
- `RubatoPiDriver.ts`: 실제 T3 `ProviderDriver` 계약을 구현한다. 모델 목록, session attach, send/steer, abort, 질문/확인 응답, 상태/사건 스트림을 Rubato bridge로 연결한다.
- `RubatoPiInventory.ts`: Pi 저장 세션을 T3의 기존 project/thread 명령으로 투영한다. cwd 기준 프로젝트를 만들고, 빈 thread에만 저장 이력을 가져오며, 실행 중인 세션만 실제 attach한다.
- `bridge.mjs`: Pi profile server에 화면 client로 붙는다. 동일 thread 중복 open을 합치고, 같은 Pi socket 재연결은 공식 client `reconnect()`를 사용해 동일 presentation client와 runtime을 유지한다. server 주소가 실제로 바뀐 경우에만 연결 객체를 교체한다.
- `events.mjs`: Pi 본문·추론·도구·질문·확인·turn 완료를 T3 `ProviderRuntimeEvent`로 정규화한다. 재접속 snapshot은 이미 투영된 본문 뒤에 남은 부분만 이어서 중복 출력을 막는다.

## 세션 의미론

다음 세 식별자는 합치지 않는다.

- 저장 대화: Pi `sessionId` / JSONL
- 실행 중 worker: Pi server가 관리하는 `runtimeId`
- 화면 연결: T3 thread/provider attachment

저장 세션 목록은 JSONL/공식 SessionManager 정보만 읽는다. 목록 조회로 runtime을 만들지 않는다. 이미 실행 중인 session을 T3에서 열면 같은 `runtimeId`에 붙는다. 실행 중 session에서 T3를 떼도 작업은 유지된다. idle + attachment 없음일 때는 Pi server 정책으로 unload할 수 있다.

## 실제 검증

GitHub Actions는 현재 T3 `3138f5716098a331f9a7d4cfc1bcd07118967a83` 소스를 새로 내려받아 guarded overlay를 적용한 뒤 전체 T3 작업공간 의존성을 설치한다.

```sh
node --test --test-timeout=90000 harness/t3-integration/test/*.test.mjs
pnpm --dir "$T3_SOURCE" --filter t3 typecheck
pnpm --dir "$T3_SOURCE" --filter t3 build:bundle
```

최종 고정점 검증에서 통합시험 7개가 모두 통과했고, 전체 T3 server 형 검사와 server bundle 빌드도 종료 코드 0으로 통과했다. 시험은 실제 T3 contracts/Effect/decider/projector/provider factory, 공식 Pi server/client/Unix transport와 실제 파일시스템을 쓴다. 모델 응답만 결정적인 시험 child process를 사용한다.

검증한 핵심 시나리오는 다음과 같다.

- 저장된 idle session 발견과 project/thread 투영
- 외부에서 이미 실행 중인 Pi session에 attach하면서 worker 중복 생성 없음
- T3 stop/Scope 종료가 Pi 작업을 종료하지 않음
- T3에서 새 session 생성과 prompt/steer
- abort
- 사용자 질문과 one-time confirmation 응답
- 강제 연결 끊김 뒤 공식 reconnect로 동일 runtime 복귀
- 동시에 들어온 reconnect 호출 직렬화
- text/reasoning/tool start·update·finish/turn 완료 사건
- 재접속 때 기존 assistant 본문 중복 방지
- 다른 client에서 생긴 저장/실행 상태를 inventory 동기화가 반영
- archive된 T3 thread를 inventory가 임의로 되살리지 않음

## 의도적으로 지원하지 않는 부분

T3 파일/그림 첨부, T3 plan mode, rewind, 자동 커밋 제목/메시지 생성은 이번 연결 범위에 넣지 않았다. Rubato에 대응 정책이 없는 T3 approval mode를 지원한다고 가장하지 않고 `full-access` 이외는 명시적으로 거부한다. 실제 외부 모델 인증과 유료 모델 호출, Desktop/Web 브라우저 수동 조작은 로컬 실환경 검증으로 남긴다.

T3는 presentation/control surface이며 Pi 세션의 source of truth가 아니다. 이 원칙을 바꾸기 위해 T3 core를 장기 fork하거나 별도 세션 DB를 추가하지 않는다.
