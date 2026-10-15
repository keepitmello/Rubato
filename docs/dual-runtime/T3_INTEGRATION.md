# T3 ↔ Rubato CLI 통합

이 문서는 구조와 소유권이다. **기능을 하나 붙이러 왔다면
[`T3_PATCHING.md`](T3_PATCHING.md)를 먼저 읽는다** — 무엇이 이미 막다른 길로 확인됐는지,
화면에 닿는지를 어떻게 확인하는지, 고친 코드가 실제로 도는 자리가 어디인지를 담았다.

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

## 되감기

T3 rewind는 Pi 세션을 바꾸지 않는다. 브리지가 T3에 남는 턴의 응답 지문과, 그 뒤로 T3가
남기는 사용자 메시지 수를 Pi `rewind` RPC(`harness/pi-runtime/features/conversation-rewind`)로
넘기고, Pi는 같은 세션 트리 안에서 그 지점으로 가지를 옮긴 뒤 도착 자리를 `rubato.rewind`
항목으로 남긴다. 세션을 다시 열면 파일의 마지막 항목에서 이어지기 때문이다. 세션 ID가 그대로라
돌던 에이전트·팀은 멈추지 않고 결과가 되감긴 대화로 들어오며, 되감긴 쪽 대화는 같은 파일에
곁가지로 남는다. `fork`는 세션을 갈아치워 자식을 옛 세션 이름으로 정지시키므로 쓰지 않는다.
T3 기록을 읽지 못하거나 남길 응답이 현재 가지에 없으면 추정하지 않고 사유와 함께 거절한다.

사용자 메시지는 턴 없이 저장되므로, T3가 되감을 때 어느 것을 남길지는 `rewind-edits.mjs`가
정한다: 사용자 메시지는 바로 다음 응답의 턴에 속한다(같은 밀리초면 사용자 메시지가 앞). 끼어든
메시지는 그 턴과 함께 남고, 자식 완료가 깨운 턴처럼 사용자 메시지가 없는 턴이 있어도 되돌린
메시지는 지워진다. CLI에서 가져온 기록은 T3처럼 Pi도 항상 남긴다.

T3는 rollback이 돌아온 뒤에 되감기를 적용하고, 그때 체크포인트 밖의 턴을 모두 지운다. 그 사이에
자식 완료가 새 가지에서 턴을 열면 그것까지 지워지므로, 브리지는 T3 기록에서 지운 턴이 사라질
때까지 Pi 이벤트를 붙잡았다가 흘려보낸다(최대 10초). 그다음 지운 턴에서 시작해 아직 도는
에이전트·팀을 턴 없이 다시 알린다. T3가 그 행들을 턴과 함께 지웠기 때문이다. 웹의 되감기 대기는
"지운 턴이 사라졌나"로 끝을 판단한다.

도구 단계로도 되감는다. 앱의 Rubato 도구 행마다 되감기 버튼이 있고, 그 단계(같이 부른 도구 묶음
전체) 직후로 돌아간다. 화면이 되감기 명령에 그 행의 호출 id와 턴을 실으면, 서버가 그 턴의 도구 행에서
단계가 끝난 시각을 읽어(`packages/shared` `rubatoStepRewind.ts`) `thread.reverted`에 실어 보내고, 세
군데 반영이 그 턴에서 그 시각 뒤에 찍힌 행을 지운다. Pi는 그 단계의 마지막 도구 결과에 가지를 걸어서,
모델이 이미 본 앞부분이 바이트 그대로 남고 다음 요청이 캐시를 그대로 읽는다. 거기서 말을 얹으면 조종
메시지처럼 도구 결과 바로 뒤에 붙고, 이어 달리기(`/rubato/step-rewind/continue`, Pi `continue`)는 메시지
없이 깨우기와 같은 실행 경로로 다시 돈다. 자기 worktree를 가진 스레드는 도구가 끝날 때마다 파일
스냅샷을 찍어 두어서 그 단계의 파일로도 되돌릴 수 있고, 그때 남은 턴의 체크포인트도 그 상태로 바뀐다.
말을 얹는 되감기는 그 메시지를 보낼 때 실제로 일어나서 보내기 전까지는 되돌릴 수 있다. 접힌 "Worked
for" 줄과 도구 묶음 줄의 되감기는 그 아래 마지막 단계 뒤로, 답변 버튼 줄의 되감기는 그 답변 직후(보통의
턴 되감기)로 간다.

git 저장소가 아닌 작업 폴더에서는 T3가 체크포인트를 남기지 않으므로, Rubato 턴이 끝날 때마다 파일
없는 자리표시 체크포인트로 턴 번호만 남긴다(`rewind-edits.mjs`). 거기서는 대화만 되감고 파일은 그대로다.

내 메시지는 Codex처럼 그 자리에서 고친다(`turn-actions-edits.mjs`). 연필을 누르면 말풍선이 편집창이
되고, 보내면 그 메시지 앞으로 대화를 되감은 뒤(파일은 그대로) 고친 메시지를 보낸다. 글 중간에 붙인
이미지는 번호 붙은 자리표시로 보였다가 보낼 때 제자리로 돌아가고, 되감기가 지운 메시지의 첨부 파일을
정리하므로 첨부는 되감기 전에 다시 올린다.

폰의 T3 앱은 되감기 버튼을 그리지 않아서, 폰에서는 `/rewind [턴 수]`로 되감는다(기본 1). 브리지는 이 명령을
Pi에 보내지 않고 그 턴을 닫은 뒤, T3 서버(`rubatoRewindCommand.ts`)에 그 명령 턴과 앞의 턴들을 되감아
달라고 한다. 서버는 명령 턴에 체크포인트 번호가 붙기를 기다렸다가 T3 자신의 대화 되감기를 내므로, Pi도
버튼 되감기와 같은 길로 되감기고 모든 화면에서 행이 같이 지워진다. T3가 보여 주는 턴보다 많이 되감으라고
하면 보내기 단계에서 거절한다.

## 답변에서 포크

답변 버튼 줄의 "Fork into new chat"은 그 답변의 턴 끝까지를 새 스레드로 복사해 바로 연다. 화면이 답변의
메시지 id를 `/rubato/thread-fork`의 `at`으로 넘기면, 서버가 거기 든 Pi 지문을 꺼내 Pi `fork`에 넘기고,
Pi는 그 답변 다음 첫 입력 앞에서 복사를 끊는다(되감기가 그 답변에 도착하는 자리와 같다). 원래 스레드는
그대로고, 사이드바의 "Fork thread"는 지금까지의 대화 전체를 복사한다.

## 의도적으로 지원하지 않는 부분

T3 파일/그림 첨부, T3 plan mode, 자동 커밋 제목/메시지 생성은 이번 연결 범위에 넣지 않았다. Rubato에 대응 정책이 없는 T3 approval mode를 지원한다고 가장하지 않고 `full-access` 이외는 명시적으로 거부한다. 실제 외부 모델 인증과 유료 모델 호출, Desktop/Web 브라우저 수동 조작은 로컬 실환경 검증으로 남긴다.

T3는 presentation/control surface이며 Pi 세션의 source of truth가 아니다. 이 원칙을 바꾸기 위해 T3 core를 장기 fork하거나 별도 세션 DB를 추가하지 않는다.
