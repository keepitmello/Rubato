# CLI / T3 공통 실행 구조

2026-09-16 · 상태: **CLI/T3 공통 엔진 구현·실설치 전환·재시작 및 관리형 CLI 실검증 완료.** 열려 있는 것은 writer fence 부재, G1(공유 쓰기 제어), G2(terminal attachment identity) 셋이다. 운영/복구 절차는 [공통 엔진 운영과 검증](COMMON_ENGINE_OPERATIONS.md)을 따른다.

이 문서는 로컬 참고 문서 `hub-absorb-handoff.md`(허브 흡수 초안)를 참고한 설계 판단이다. 사용자 소유 원본 초안은 수정하지 않는다. “허브를 Pi 서버에 흡수”라는 파일/프로세스 이동 자체가 목표가 아니다.

근거 원장은 Rubato-lab의 `_workspace/runtime-architecture-20260915/`와 `_workspace/runtime-architecture-20260916/`에 있다. `baseline.md`, `owner-design.md` §9, `design-review.md`, `lead-stock-control-probe.json`, `lead-lock-probe.json`, `lead-zmx-handoff-probe.json`, `lead-feasibility.md`를 함께 본다. 독립 검토는 초기 후보를 NOT READY로 판정했다. 아래는 그 지적과 리드의 설치본 재검증을 반영한 새 권고안이며, 이 전체 안이 독립 검토를 통과했다고 주장하지 않는다.

## 1. 현재 구조 — CLI와 GUI 모두 하나의 프로필 엔진에 연결

사용자 승인: “해보자. 코덱스 데스크탑 앱처럼 하나의 엔진이 여러 스레드를 관리하는 식으로. cli던 gui던”. Intent `dual-runtime-lifecycle` revision 5. GUI만의 실험에서 CLI/GUI 공통 엔진으로 범위를 넓혔다.

```text
CLI 터미널 입출력 ─┐
T3 기존 어댑터 ────┼─ 공식 Pi Server / SessionRouter (프로필당 1개 엔진 프로세스)
                  │    ├─ 대화 A: AgentSession + JSONL + 세션별 확장/도구
                  │    ├─ 대화 B: AgentSession + JSONL + 세션별 확장/도구
                  │    └─ 대화 C: AgentSession + JSONL + 세션별 확장/도구
                  └─ 화면/연결 종료와 엔진/대화 종료를 분리
```

구현 구조:
- **공식 SessionRouter가 SDK 대화를 소유한다.** `SessionWorker`는 같은 프로세스 안에 대화별 AgentSession을 만들고, 기존 RPC 명령·질문 처리기를 세션 전용 transport로 재사용한다.
- **CLI는 기존 UI를 그대로 쓰는 얇은 터미널이다.** native main/InteractiveMode가 엔진에서 동작하며, 별도 CLI 프로세스는 키 입력·화면 바이트·크기 변경·로컬 외부 editor만 전달한다. 새 renderer나 대화 DB를 만들지 않는다.
- **선택 커서와 대화 수명을 분리한다.** /new·/resume·fork·import는 CLI의 선택을 바꾼다. GUI가 보던 원래 route/JSONL writer는 바꾸지 않는다. 대상 획득 실패 시 이전 대화를 보존한다.
- UI 테마·키보드·이미지 상태와 cwd/환경/HTTP proxy pool은 명시적 async context에 격리한다. native trust·모델·설정·확장 factory는 공용 생성 경로를 사용한다. extension startup은 화면 재접속 때 반복하지 않는다.
- 동일 대화의 CLI 제어권은 하나만 허용한다. GUI 관찰은 가능하고, CLI가 제어 중인 대화를 GUI에서 동시에 변경하려 하면 명시적으로 거부한다.
- CLI와 T3가 같은 discovery/프로필 lock을 사용한다. 설치 receipt에 두 공통 실행 feature가 있으면 소스 launcher가 공통 엔진으로 연결한다. **이전 엔진이 실행 중이면 종료하거나 두 번째 엔진을 만들지 않는다.**
- 초기 설정 파일 보정도 lock을 가진 엔진 한 곳에서만 수행한다. 여러 CLI가 동시에 settings/models JSON을 덮어쓰던 시작 경합을 제거했다.
- 사용하지 않는 AST MCP 프로세스는 discovery 후 닫고, 도구 실행 때 다시 연결한다. 실행 후 유휴 1분에 회수한다. 도구 목록·검색·호출 의미는 유지한다.
- 외부 도구 프로세스와 명시적으로 process 실행을 요청한 task child까지 없앤다는 뜻은 아니다. 일반 CLI/T3 대화의 완전한 엔진 중복을 제거한다.

격리된 실제 소스 CLI 5개와 공식 GUI client를 동시에 실행했다. CLI마다 확인한 engine PID가 동일했고, 서로 다른 인증 환경으로 loopback provider를 호출했다. CLI 종료 후 GUI가 같은 runtime ID로 이어갔다. 실제 PTY의 한글 입력, /new, /resume 선택 및 정상 raw/alternate-screen 복원을 확인했다. native 저장/메모리 fork, import, writer 이름 변경, 제어 충돌, 질문/취소/재접속도 별도 검사했다.

| 최종 동일 후보16, 짧은 local 응답 후 안정화 | 대화 엔진 | 전체 자식 포함 프로세스 | RSS 합계 | 엔진 유휴 CPU |
|---|---:|---:|---:|---:|
| 1대화 · 개별 실행 | 1 | 1 | 254 MiB | 1.60% |
| 1대화 · 공통 엔진 | 1 | 2 | 313 MiB | 1.71% |
| 5대화 · 개별 실행 | 5 | 5 | 1,284 MiB | 6.32% |
| 5대화 · 공통 엔진 | 1 | 6 | 566 MiB | 1.94% |

**5대화의 RSS는 약 56% 감소**했다. 반면 1대화에서는 얇은 CLI 클라이언트 때문에 약 59MiB가 늘었다. 모든 경우에 가벼워진다는 뜻이 아니라 여러 대화의 엔진 중복을 줄이는 구조다. 두 경로 모두 AST 유휴 회수를 켠 같은 Node24.18.0/Pi0.85.1/45-feature 후보를 사용했다. 5초 안정화 후 10초 유휴 CPU를 측정하고 RSS를 수집한 단일 표본이다. CPU는 고유 엔진 PID의 누적 사용 시간으로 계산한 한 코어 기준이며, 프런트엔드/도구 자식 CPU는 제외한다. RSS는 전체 관련 프로세스의 합계이지 물리 메모리/PSS나 모든 실사용 부하의 보장이 아니다. 유료 API는 호출하지 않았다.

이전 즉시 측정은 AST eager→lazy 변경까지 포함해 1,916→695MiB(약64%)였다. 위 최종 동일 조건 비교와 혼용하지 않는다. 시작 속도 개선도 주장하지 않는다. 원본과 재현 명령: `_workspace/runtime-architecture-20260915/common-resource-final.md`.

**GUI actor는 TUI를 만들지 않는다 (2026-09-16 실측).** GUI/RPC로 만든 대화는 `appMode: 'rpc'`로 시작하므로([hosted-runtime.mjs](../../harness/pi-server/src/hosted-runtime.mjs)) `InteractiveMode` 생성자를 거치지 않는다. `InteractiveMode`는 terminal socket으로 붙은 presentation 경로([terminal-session.mjs](../../harness/pi-server/src/terminal-session.mjs))에서만 생성된다. 격리 엔진에 생성자 계수기를 주입해 확인했다: actor 0개와 GUI actor 1개에서 생성 0회, TUI actor 1개에서 1회다. 같은 30초 유휴 창의 한 코어 CPU / 끝 RSS는 0 actor **0.11% / 358.3MiB**, GUI actor 1개 **0.23% / 443.0MiB**, TUI actor 1개 **0.42% / 478.9MiB**였다. `InteractiveMode` 모듈 자체는 `main.js`의 정적 import로 엔진 시작 때 적재되지만 **적재는 생성이 아니고** `Tui.start` 전에는 render loop가 없다. 단일 표본이며 모델 호출·도구·다중 actor 부하·장기 유휴는 포함하지 않는다. 원장: `_workspace/runtime-architecture-20260916/gui-actor-tui-probe/`.

닫힌 UI 약한 참조 2개는 GUI actor를 유지한 채 모두 회수됐고, SDK 5개 로드/회수 4회에서도 잔존 참조는 매번 0이었다. 첫 메시지의 JSONL exclusive-create 충돌, 오래된 UI callback 보유, client unsubscribe/close 경합을 실패 증거로 재현한 뒤 수정했다. 답변을 기다리는 도구의 질문창을 닫을 때 생기던 종료 교착도 재현했다. 취소를 시작한 후 native 질문/입력/editor/custom UI의 대기까지 해제하고 도구 종료를 기다린다. remote-control 확장이 비활성인 경우에도 동작한다.

**최종 전환:** 후보20의 관리형 CLI까지 검증한 뒤 공식 installer로 설치본을 교체하고 T3/프로필 엔진을 재시작했다. 실제 `rubato new --detach` 5개가 hub/zmx를 거쳐 같은 엔진 PID에 연결됐고, 한국어 native 렌더링·`/new`·기존 T3 bridge의 대화 재개가 통과했다. 검증용 JSONL 6개는 사용자 목록에서 별도 백업으로 옮겼다. 저장 대화483개와 원본 파일893개, 인증·설정·모델·신뢰 설정은 전환 전과 같고 기존 허브는 재시작하지 않았다.

관리형 CLI의 surface는 SDK actor가 아니라 terminal presentation 소유다. 창별 환경/token을 명시적으로 넘기고 별도 presentation-bind에서 제어 capability를 갱신한다. `/new`·재개 시 확장 startup을 반복하지 않으며, 과거 actor의 종료가 현재 창의 `live.exited`로 전파되지 않는다. 닫힌 화면은 허브 연결·heartbeat를 정리한다.

**검증 경계:** 관련 집중 검사72개와 자체 격리 native 검사2개, 실제 T3 Driver/공식 candidate 연결 검사는 통과했지만 전체 legacy/runtime suite는 green이 아니다. 설치 상태를 전제하는 legacy 검사, 기존 child write-tool 미발견 및 compaction adapter assertion 등이 남고, 전체 타입 검사에는 기존 오류3개가 남는다. 과거 광범위 검사38개 실패를 모두 baseline으로 입증한 것은 아니다. 임의 외부 확장의 전역 singleton 안전성·실제 유료 provider·장기 실사용 부하는 보장하지 않는다. `fullRubatoParity:false`를 유지한다.

최신 재현 명령과 증거: Rubato-lab `_workspace/runtime-architecture-20260915/common-cli-implementation.md`.

## 2. 확인된 사실

### 이중 writer는 정상 append만으로 기본 분기를 갈라놓는다

독립된 두 SDK probe 모두 같은 결과다. 같은 JSONL을 읽은 A/B가 각자 append하면 파일의 7줄은 남지만 마지막 leaf의 parent walk는 B의 대화만 따라가고 A의 대화가 기본 화면/context에서 빠진다. 원본 bytes가 사라졌다는 주장은 철회한다. 실제 truncate/rewrite는 구버전 migration·빈 파일 초기화 등 별도 전제가 있다.

따라서 lock은 append 한 줄 동안만 잡는 것이 아니라 **해당 대화를 hydrate한 AgentSession의 쓰기 수명 전체**를 보호해야 한다. leaf를 읽어 비교하는 것만으로는 check→append 경쟁이나 이미 만들어진 모델 context의 stale 상태를 막지 못한다.

### stock 런타임에는 전환 소유자가 따로 있다

설치된 `AgentSessionRuntime`은 `AgentSession` 및 cwd-bound services의 교체를 소유하고, `InteractiveMode`는 그 runtimeHost에 연결된다. stock `switchSession`은 대상 SessionManager를 연 다음 기존 session을 abort/dispose하고, 이후 새 runtime을 만든다. **새 runtime 생성 실패 시 이전 실행을 그대로 유지하는 트랜잭션이 아니다.** extension event context에 몇 개 메서드를 덧붙이는 수준으로 이 문제를 해결했다고 볼 수 없다.

또한 `/resume` selector의 rename은 `SessionManager.open(...).appendSessionInfo(...)`를 직접 호출한다. 입력/모델 turn만 fence를 적용하면 이 별도 writer를 놓친다. 서비스의 empty-session create, migration, fork/import와 함께 쓰기 진입점 목록에 포함한다.

**`SessionManager.open` 자체가 이미 writer다 (2026-09-16 확인).** 빈 파일 초기화와 migration의 `_rewriteFile` 외에, `loadEntriesFromFile`이 끝 줄 개행을 고칠 때 `appendFileSync`를 부른다(설치본 `core/session-manager.js:321`). 따라서 fence는 append 지점이 아니라 모든 `open`/`create`/`wx` **앞에** 놓여야 하고, stock `switchSession`이 teardown보다 먼저 대상을 `open`한다는 위 사실과 겹쳐 읽는다. 또 `flock`은 프로세스 단위라 같은 엔진 안의 두 SessionManager를 막지 못하므로, [session-ui/patches.mjs](../../harness/pi-runtime/features/session-ui/patches.mjs)의 in-process live-writer 검사는 OS fence가 생겨도 대체되지 않는다. 설치된 Node24.18.0에는 `FileHandle.lock`도 `O_EXLOCK`도 없어 `flock(2)`에는 별도 네이티브 바인딩이 필요하고, 현재 `profile-server.mjs`가 쓰는 `proper-lockfile`은 stale-PID lease라 이 용도에 부적합하다. 쓰기 진입점 전수와 근거: `_workspace/runtime-architecture-20260916/gap-feasibility-map.md`.

## 3. 책임과 식별자

| 개념 | 식별 / 소유 / 수명 |
|---|---|
| 저장 대화 | profile + Pi sessionId. canonical file/inode 관계는 별도 검증. UUID만 같은 복제 파일은 ambiguous로 처리하고 임의 선택하지 않는다. |
| 실행 인스턴스 | workerId + process birth identity. PID 단독 식별 금지. 하나의 worker가 `/resume`로 다른 대화에 bind될 수 있다. |
| 현재 대화 binding | sessionId + workerId + **bindingEpoch**. 같은 PID가 파일을 바꿀 때 반드시 epoch가 바뀐다. |
| TUI 창 | 기존 liveSessionId/zmx identity. 저장 대화와 같은 ID가 아니다. |
| 화면 연결 | attachmentId + surfaceKind + observe/control/terminal 수명. T3 thread는 attachment가 아니라 저장 대화에 durable bind한다. |
| 출력 event | worker incarnation + bindingEpoch + eventSeq. 늦은 다른 대화 event를 기존 thread에 넣지 않는다. |
| 명령 | requestId + 대상 sessionId/worker incarnation/bindingEpoch. 사용 중 state revision은 별도의 낙관적 검사이며 identity guard를 대신하지 않는다. |

서버와 T3는 JSONL 원본의 두 번째 writer가 아니다. T3의 기존 project/thread DB는 화면 projection과 binding에만 사용한다. 도구 결과 대용량 payload는 원본 artifact + 크기 제한된 참조/preview로 취급하며, 제한 초과를 이유로 모델 입력이나 저장 원본을 변형하지 않는다.

## 4. 공통 control port

기존 RemoteSurface 전송·buffer·request ID와 Pi/T3의 snapshot/event 경험을 재사용한다. 모든 SDK 내부를 원격으로 노출하지 않는다.

stock adapter의 연결 위치는 일반 extension event context가 아니라 **runtimeHost + 현재 AgentSession + 실제 InteractiveMode의 UI resolver** 경계다. SDK가 제공하는 runtime 교체 hook을 우선 사용하고, 부족한 부분만 현재 pin에 대한 작은 host adapter/검증된 transform으로 보완한다. 별도 headless command interpreter나 두 번째 session runtime을 만들어 기능을 흉내 내지 않는다.

- worker state/snapshot/conversation page/model catalogue
- submit/steer/follow-up, abort (진행 중 turn 종료를 기다리는 FIFO 뒤에 가두지 않음)
- model/effort 선택, rename, compact
- 동일 worker에서의 new/resume/fork/reload 전환
- standard UI request/response/select/confirm/input 및 request 취소
- terminal-required custom UI는 기존 CLI 경로에서 그대로 처리; T3가 지원한다고 허위 표시하지 않는다. 현재 T3의 standard question/confirmation 기능은 잃지 않는다.

직접 TUI 키 입력과 원격 명령이 **동일한 실행 소유자**를 호출한다. 긴 turn 전체를 queue lock으로 잡지 않는다. 명령의 acceptance와 turn completion은 구분한다. session switch는 쓰기/모델 작업/질문을 quiesce한 뒤 다음 binding을 commit하는 barrier다.

매 명령은 접수와 실제 실행 직전 대상 epoch를 검사한다. async 준비 후에도 적용 직전 재검사한다. 질문 response와 replay cache 역시 epoch에 묶는다. timeout/disconnect 뒤 non-idempotent submit을 자동 재전송하지 않는다. 같은 requestId 결과를 확인하거나 outcome-unknown으로 남긴다. 서비스/worker 재시작을 넘어 exactly-once를 근거 없이 약속하지 않는다.

현재 ActionRequestEnvelope는 liveSessionId와 optional expectedRevision만 있고 sessionId/epoch는 없다. 프로토콜 capability/version 협상으로 추가하며, 미지원 worker에는 쓰기 공유를 활성화하지 않는다. unknown capabilities는 idle/free의 증거가 아니다.

## 5. 한 writer 보장과 전환

### 두 층은 중복 registry가 아니라 역할이 다르다

1. **서비스 acquire/route**: 동일 대화 요청 합치기, 살아 있는 owner 재사용, 조용한 startup, attachment 관리.
2. **worker 측 배타 fence**: 서비스 장애·동시 부팅·exit75 direct·다른 진입점을 통과해도 두 AgentSession이 같은 대화를 쓰지 못하게 하는 마지막 경계.

단순 heartbeat lease 디렉터리를 새 liveness SSOT로 만들지 않는다. fence는 프로세스 수명에 연동된 OS advisory exclusive lock 같은 primitive가 적합하다. 별도 고정 sidecar lock inode를 쓰고 살아 있는 동안 unlink/replace하지 않는다. canonical path와 hardlink/alias 검증을 포함하고, lock 획득은 SessionManager.open/migration/hydration보다 앞서야 한다. metadata만 있는 파생 index는 이 lock을 소유하지 않는다.

Mac 격리 primitive probe: owner 실행 중/ SIGSTOP 중에는 lock 획득 불가, owner 사망 후 가능. **Node/실제 엔진에 연결한 구현은 아직 아니다.** 런처에서 한 번 잡는 방식이나 매 append 전 leaf 비교로 대체하지 않는다. 범위는 fence를 준수하는 Rubato writer다. 외부 stock Pi/수동 파일 편집 등 비협조 writer까지 OS advisory lock이 막는다고 주장하지 않는다.

활성 대화의 rename 같은 metadata 쓰기도 owner로 전달한다. 비활성 대화의 생성/rename/import는 동일한 fence 규칙 아래 짧은 쓰기 작업으로 수행한다. 읽기 전용 목록/이력은 migration을 일으키는 `SessionManager.open`으로 구현하지 않는다. 서버가 JSONL의 독립적인 두 번째 writer가 되는 기존 편의 경로를 최종 구조에 남기지 않는다.

### 대화 전환 순서

- unowned B로 `/resume`: 먼저 A를 계속 소유해야 하는 T3 binding/work hold와 CLI view의 이동을 분리한다. **T3의 A thread를 B로 따라가게 하거나 A에 남아야 할 실행을 교체하지 않는다.** 이 경우 B worker를 준비하고 CLI 연결을 이동한다. A를 해제해도 되는 단독 전환에서만 in-process 재사용을 후보로 둔다.
- in-process 재사용 후보의 필요 계약: A의 작업/질문 정리 → B fence try-acquire 및 준비 → binding epoch/identity 전환 → A fence 해제. 두 worker가 A↔B를 바꾸는 경우 기다리며 lock을 교착시키지 않는다. B open/fence 실패는 A를 유지해야 한다. **B runtime 생성 실패까지 A가 그대로 남는다는 보장은 현 stock 구현에 없다.** 준비 단계의 side effect와 실패 복구를 검증하기 전 이 재사용 경로를 채택하지 않는다. worker 고정 방식과의 최종 선택에는 extension의 `withSession` callback 호환성도 포함한다.
- 이미 owner가 있는 B: 새 writer로 B를 열지 않고 기존 B worker의 terminal/control attachment로 이동한다. 현재 창의 `/resume` UI 이후 **terminal client를 해당 worker로 넘기는 경계**가 필요하다.
- fork/new: 새 session identity를 먼저 예약하고 fence를 잡은 뒤 새 file/binding을 공개한다. T3의 원래 thread binding은 원래 대화에 남고 새 대화는 별도 thread다.
- 서버 재시작: 이전 worker를 죽이지 않음. zmx identity + birth identity + worker challenge + fence 상태를 대조해 adopt. heartbeat 부재/PID 존재만으로 소유권을 넘기지 않는다.
- 설치 전부터 살아 있는 구버전 worker: 협조 fence를 보유한다고 추정하지 않는다. 읽기/관측은 유지하되 capability와 실제 owner를 확인하기 전 신규 writable 공유/대체 worker를 띄우지 않는다. 사용자 작업을 강제 재시작해 이행을 숨기지 않는다.

**terminal handoff의 전송 primitive는 통과했고, 제품 라우팅은 미검증이다.** 실제 설치 zmx와 격리 PTY에서 A의 attach client 하나만 종료한 뒤 같은 PTY로 B에 attach했다. worker PID 두 개는 그대로였고 A/B의 다른 client는 계속 응답했다. worker가 아니라 CLI attach supervisor가 client 프로세스를 교체하는 경계가 가능하다는 증거다. synthetic line worker 시험이므로 실제 `/resume`·화면 복원·resize·GUI 동등성 증거는 아니다.

남은 중요한 구분은 **누구의 연결을 옮기는가**다. stock TUI의 input 및 `session_before_switch` API에는 terminal attachment ID가 없다. 하나의 TUI를 여러 터미널이 공유할 때 어느 client가 `/resume` 선택을 했는지 이 callback만으로 추정하지 않는다. 기존의 같은 TUI view 공유 의미를 보존하는 이동과, 특정 client만 옮기는 새 동작을 구분해 검증해야 한다. 제품 계약 없이 임의로 전체 client를 detach하거나 특정 client만 이동시키지 않는다. T3의 기존 대화 binding 및 대상 B의 기존 연결은 별개로 보존한다. 이 라우팅·호환성 경계를 풀지 못하면 본 target을 재검토한다.

## 6. 연결·대기·종료 정책

현재 hub는 zmx clients=0이고 persist가 없으면 SIGSTOP을 보낸다. Pi server는 별도로 idle60초 회수를 한다. **T3가 붙었다는 이유만으로 이 두 정책이 서로를 인식하지 않는다.** [hub.ts](../../packages/rubato-remote-hub/src/hub.ts), [registry.ts](../../packages/rubato-remote-hub/src/registry.ts).

공통 서비스에서 다음 조건을 명시적으로 분리한다.

- **observer**: sidebar/inventory/history 조회. worker를 생성하거나 영구 유지하지 않는다.
- **interactive/terminal attachment**: 실제 사용자 연결. terminal resize/render 연결은 engine 실행과 분리한다.
- **work hold**: streaming, compaction, 진행 중 tool/명령, queued user input, pending UI response, background wake. 화면 disconnect로 해제하지 않는다.
- **retention**: 기존 CLI/persist 정책과 GUI idle 정책. 하나의 policy 함수가 surface별 기존 의미를 표현한다. 기존 TTL을 아무 이유 없이 전부60초로 통일하지 않는다.

T3에서 작업 중인 worker를 zmx clients=0만 보고 멈추면 안 된다. 동시에 sidebar를 열었다는 이유로 모든 stored 대화를 살려 두어서도 안 된다. idle/unobserved worker 정리는 원본 보존 후 cooperative shutdown→물리 종료 확인 순서다. pending user question은 조용히 회수하거나 자동 응답하지 않는다.

## 7. 남은 gate — G1 / G2

**G1 — control + ownership**: 실제 stock build를 사용하는 격리 worker에서 CLI/remote 입력, standard 질문/확인, abort, resume/fork/reload, epoch에 묶인 late response, 프로세스 pause/crash, 동시 acquire와 branch 보존. 전환 중 runtime 생성 실패, T3 A binding 보존, selector rename 및 extension `withSession`도 포함한다. SDK in-process mock만 통과하면 부족하다.

**G2 — terminal handoff**: GUI-first로 뜬 worker에 CLI attach해 PID/worker/branch가 그대로인지; A의 `/resume`가 이미 살아 있는 B로 갔을 때 CLI view/attachment 이동 범위가 기존 의미와 맞고 대상 B 연결 및 T3 작업을 건드리지 않는지. 기존 RPC 대비 process-tree RSS/CPU/FD와 cold/warm latency를 함께 비교한다. synthetic zmx client 교체 통과만으로 G2 전체를 닫지 않는다.

attachment id 부재는 2026-09-16에 코드로 확인했다. stock `SessionBeforeSwitchEvent`는 `{ type, reason, targetSessionFile? }`뿐이고(설치본 `extensions/types.d.ts:464-468`), Rubato의 terminal wire·open frame·`terminal-server`·`TerminalProcess` 어디에도 id가 없다(`terminal-session.mjs`의 `pid`는 엔진 pid다). 현재 설치본은 socket 1개 = `InteractiveMode` 1개 = cursor 1개이고 `claimPresentation`이 두 번째 CLI 제어자를 거부하므로 이 경쟁은 아직 만들어질 수 없다. id는 여러 terminal이 한 TUI를 공유하는 기능을 만들 때 함께 도입한다.

G1/G2가 실패하면 이유를 설계로 환류한다. GUI read-only/auto-fork나 새 TUI를 몰래 대체안으로 도입하지 않는다. 별도 모델 리뷰를 추가하지 않고 리드가 직접 이어가라는 사용자 지시를 따른다.

## 8. 저장 목록 최적화 구현

사용자 승인: "ㅇㅇ 리소스 최적화 최대한 진행해보자 너가 직접 해줘. 기존 동작이나 사용방식을 해치지 않으면서 내부 엔진 붙는 것만 바꾸면 될거같은데". 리드가 직접 구현했고 추가 에이전트는 사용하지 않았다.

- `SessionFiles`: canonical path 및 dev/inode/size/mtimeNs/ctimeNs/mode cache, 동일 scan 공유, 폴더 전체를 합친 조회 IO 동시성 10. warm list/resolve는 본문을 다시 읽지 않는다. create는 생성한 한 파일만 읽어 등록한다.
- `session-metadata.mjs`: pinned Pi metadata 의미론을 재현하는 read-only streaming parser. 검색에 쓰지 않는 전체 대화 문자열을 누적하지 않는다. 첫 user text, latest title/clear, message count, activity time과 기존 폴더별/전체 정렬을 보존한다.
- 변경 파일은 전체를 다시 읽되 시작 시점 size로 읽기를 제한한다. 읽는 동안 바뀐 파일을 완성된 cache로 인정하지 않는다. append-tail 추정, watcher, 새 DB, 원본 migration은 추가하지 않았다.
- `host`: text delta는 session stream으로 그대로 전달하고 상태가 달라질 때만 목록을 갱신한다. 전체 목록 비교 후 실제 표시 필드가 같으면 revision/publish를 생략한다. attachment/running/waiting/idle 변화는 계속 전달한다.
- 목록만 사용하는 프로세스는 agent/TUI/provider SDK를 로드하지 않는다. public SDK는 create/transcript 때 지연 로드하며, 원본 writer API와 transcript 의미론은 유지한다.

최종 회귀검사: **Pi server 27/27, T3 bridge/실제 driver·projector 계약 14/14, CLI 40/40**. Pi 검사에는 실제 설치 stock candidate를 격리 profile에서 시작·resume하는 시험이 포함돼 skip이 없다. 유료 모델 호출/실제 TUI 조작 시험은 아니다. 기존 Pi와 160개 생성된 정상/손상 조합을 differential test했고, timestamp의 sub-ms 반올림과 비정상 날짜의 폴더별 정렬 차이를 발견해 기존 결과에 맞췄다.

실측 원장은 `_workspace/runtime-architecture-20260915/real-index-final-{legacy,optimized}.json`, `event-fanout-after.json`, `host-import-{before,after}.json` 및 `resource-optimization.md`다. 재현 방법은 [측정 절차](PERFORMANCE_MEASUREMENT.md)를 따른다. 이 단계는 목록/갱신 비용 개선이며 이중 writer 방지나 CLI/T3 단일 worker 통합을 완료한 것이 아니다. 실행 중인 기존 서버를 재시작하지 않았으므로 live 적용 결과와 구분한다.

같은 483개/736,255,621 bytes 이력에서 metadata 결과 hash는 모두 일치했다. 변경 전 조회 2회 중앙값 **2,376.151ms → warm 5회 중앙값 7.654ms**, warm JSONL 읽기 **483개/736MB → 0개/0bytes**. 첫 cold 조회는 **2,388.232ms**로 여전히 전체 parse 비용이 남는다. 격리된 현재 host의 30초 대기 측정은 한 코어 CPU **1.154%**, poll14회 동안 본문 read0/revision0/worker0이었다. 기존 live 프로세스의 CPU가 실제로 내려갔다고 주장하지 않는다.

## 9. 푸시·live 반영

후속 승인: "재시작/푸시 하고, 통합 작업까지 이어가보자". 목록 최적화 `47991db8c`를 `origin/rubato/base`에 전달하고 원격 SHA를 read-back했다. 활성 runtime/worker 0을 확인한 뒤 기존 Pi profile server만 정상 종료했으며 T3가 원래 복구 경로로 재시작했다. live hub·CLI·T3 앱과 설치 stock engine/config는 건드리지 않았다.

483개 저장 세션의 serverId·socket·목록 metadata digest가 전후 동일하다. 같은 호스트에서 재시작 직전/직후 각각 30초 관측한 한 코어 CPU는 **85.88% → 3.08%**, 끝 RSS는 **1,146,535,936 → 378,044,416 bytes**였다. 이는 순차 idle 실측이며 GC/프로세스 나이가 달라 엄밀한 동조건 A/B는 아니다. 세부는 [측정 기록](PERFORMANCE_MEASUREMENT.md)을 따른다.

## 10. stock TUI 제어 연결

설치 경로는 유지하고 후보 소스에 다음을 구현했다. 이 단계는 한 대화의 CLI/T3 worker 통합을 활성화하지 않는다.

- `remote-surface/patches.mjs`: pristine stock0.85.1 hash를 검증하는 작은 TUI binding/invalidation hook. 새로운 AgentSession·renderer·writer를 만들지 않는다.
- `stock-ui-host.mjs`: 기존 TUI의 binding에만 묶인 control port. 일반 extension event context를 command context로 오인하지 않고 **실제 현재 ExtensionRunner의 command actions**를 호출한다. new/fork/navigate/reload와 user bash가 원래 TUI 경로를 사용한다.
- 세션 교체뿐 아니라 `/reload`의 **동일 AgentSession + 새 ExtensionRunner**도 오래된 제어 capability를 무효화한다. 과거 UI requestId의 늦은 응답은 새 질문에 적용되지 않는다.
- bound extension UI의 select/confirm/input은 기존 실물 컴포넌트·callback·timeout·AbortSignal을 사용한다. 원격 응답과 terminal 응답 중 먼저 완료된 경로만 유효하며 reset/reload에서 pending promise를 정리한다. 비활성 factory는 기존 UI 함수를 바꾸지 않는다.
- reload 중 factory를 끈 경우에도 기존 UI wrapper·event listener 참조를 해제하고 원래 native UI 함수로 돌아가는지 확인한다.
- 허브와 surface dispatcher 두 곳의 FIFO가 질문 응답/abort를 막던 문제를 수정했다. 일반 변경 명령은 FIFO를 유지하고 `ui.respond`, `agent.abort`, `bash.abort`만 즉시 전달한다. 중복 요청은 진행 중에도 같은 결과를 공유하며 허브는 실제 dispatch 시 revision을 다시 확인한다.
- 격리 통합 시험에서 shutdown 뒤에도 journal 쓰기가 남는 race를 발견했다. 허브 socket server는 미등록/control socket도 회수하고, 수신 완료한 비동기 frame 처리·기록이 끝나야 close를 완료한다. 중복 close는 같은 완료를 공유한다. 응답 통로를 다시 직렬화하거나 임의 sleep/retry로 증상을 숨기지 않았다.

검증은 **격리 staged stock InteractiveMode + AgentSessionRuntime + 기존 Unix 허브/두 action queue**를 사용한다. 질문 12개에서 원격 응답, 키보드 Enter/Escape, 잘못된 값/중복/늦은 응답, timeout/abort, 겹친 질문, reload 정리, before-switch 허용/거부를 검사한다. fork/resume/new 후 원본 JSONL bytes가 보존되는지 확인하고, 응답 기능을 고의로 끈 negative control이 실제로 실패하는지도 검사한다. 터미널 출력만 억제했고 실물 컴포넌트 render/input을 사용했지만 **실제 PTY/zmx·T3 화면의 종단 간 동등성 시험은 아니다**.

남은 gate: writer lifetime fence, process/attachment epoch, 같은 대화의 실제 CLI/T3 PID 공유, native `/resume` attachment routing. project-trust/shortcut의 별도 UI context, custom/editor UI, 입력/queue/timeline의 전체 parity는 이 시험으로 증명하지 않는다. 따라서 **G1/G2 전체 통과로 취급하지 않는다**.

검사: stock remote/UI/input **22/22**, CLI+action dispatcher **45/45**, T3 **14/14**, hub typecheck 통과. Hub 전체는 **66/68**이며 HTTP message paging 2건은 변경 전 `47991db8c` 격리 사본에서도 동일하게 실패한다. 과거 `bb8c1492d`의 journal 조회 경로 변경과 기존 시험의 dispatched-page 가정이 어긋난 상태이며, 이번 queue 수정의 회귀로 보지 않는다. 이 단위에 HTTP 동작/시험 기대값의 별도 변경을 섞지 않는다.

전체 **43개 feature**와 Rubato components를 조립한 격리 후보 빌드도 ready이며, 그 후보를 실제 실행 대상으로 한 Pi server 검사는 **27/27, skip0**이다. 빌드 receipt의 `fullRubatoParity: false`는 유지한다. 설치본 전환이나 유료 모델 호출을 하지 않았다.
