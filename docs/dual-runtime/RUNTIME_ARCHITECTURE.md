# CLI / T3 공통 실행 구조 — 감사 후 권고 설계

2026-09-15 · 기준 `rubato/base@94f0c7087` · 상태: **목록/갱신 비용 최적화 구현·격리 검증. 공통 엔진 통합 및 live 반영 전.**

이 문서는 로컬 참고 문서 `hub-absorb-handoff.md`(허브 흡수 초안)를 대체하는 현재 설계 판단이다. 사용자 소유 원본 초안은 실패 이력으로 보존하며 이 변경에 포함해 배포하지 않는다. “허브를 Pi 서버에 흡수”라는 파일/프로세스 이동 자체가 목표가 아니다. 목표는 **같은 대화의 실행·기록 소유자 하나, CLI/T3의 동일 실행 공유, 불필요한 상시 비용 제거**다.

근거 원장은 Rubato-lab의 `_workspace/runtime-architecture-20260915/`에 있다. `baseline.md`, `owner-design.md` §9, `design-review.md`, `lead-stock-control-probe.json`, `lead-lock-probe.json`, `lead-zmx-handoff-probe.json`, `lead-feasibility.md`를 함께 본다. 독립 검토는 초기 후보를 NOT READY로 판정했다. 아래는 그 지적과 리드의 설치본 재검증을 반영한 새 권고안이며, 이 전체 안이 독립 검토를 통과했다고 주장하지 않는다.

## 1. 결론과 선택

**기존 live hub의 실행 관리 기반을 공통 세션 서비스로 정리하고, 실제 AgentSession을 가진 worker에 CLI와 T3가 함께 붙는다.** Pi 서버의 별도 worker 소유권을 영구 병존시키지 않는다. JSONL은 대화 원본이고, 목록·liveness·T3 projection은 각각 파생 뷰다.

```text
CLI picker / attach ─┐
T3 provider adapter ─┼── 공통 세션 서비스 (기존 live hub 기반)
remote / vault ──────┘       │
                            ├─ 저장 목록: 경량 metadata index (파생 상태)
                            ├─ 실행 목록: worker identity / attachment / recovery
                            └─ acquire / route / observe
                                      │
                         대화당 하나의 terminal-capable worker
                         ├─ Pi AgentSession + SessionManager (기록 소유자)
                         ├─ 기존 TUI / zmx 연결
                         └─ 공통 control + event + snapshot port
                                      │
                                    JSONL
```

- 이미 CLI에서 돌고 있으면 T3는 **그 worker에 붙고** RPC worker를 새로 띄우지 않는다.
- GUI에서 먼저 실행한 대화도 CLI 연결이 가능한 같은 종류의 worker를 쓴다. 나중에 CLI가 열렸다고 실행기를 교체하지 않는다.
- GUI-only worker의 TUI는 terminal attachment가 없을 때 그리기/애니메이션을 멈출 수 있어야 한다. AgentSession은 필요한 작업을 계속한다. 이 성질은 아직 구현·실측되지 않았으므로 통합 진입 시험 대상이다.
- 한 서비스가 명령 접수·worker 발견·정리 정책을 소유한다. hub와 Pi host가 각각 TTL/부착 상태를 판단하게 두지 않는다.
- 서비스는 worker 프로세스의 생존과 동일하지 않다. 서비스 재시작 때 zmx/worker의 진행 중 작업을 죽이지 않고 다시 발견한다.
- 기존 CLI 런처·피커·부팅 진입점은 유지한다. remote/vault/pairing/push 구현을 다시 만들지 않는다. `rubato-codex`는 이 설계 범위 밖이다.

### 선택하지 않은 안

| 안 | 판정과 이유 |
|---|---|
| 두 실행기를 유지하고 lease가 있으면 T3를 read-only로 전환 | 임시 안전장치는 될 수 있어도 동일 실행 공유가 아니다. 최종 목표로 채택하지 않는다. |
| T3가 항상 fork | 대화 의미를 바꾸므로 채택하지 않는다. |
| 모든 TUI를 원격 headless engine의 새 renderer로 재작성 | 장기 대안일 뿐 우선안이 아니다. 설치된 InteractiveMode는 AgentSession의 서로 다른 멤버 59개와 extension UI에 직접 의존한다. `/resume`뿐 아니라 custom UI·동기 속성까지 원격화해야 하므로 “얇은 연결”이 아니다. |
| 현재 TUI control을 그대로 연결하면 완성 | 설치본 실험에서 반증됐다. 제어 포트를 먼저 보완해야 한다. |
| 기존 hub 제거 후 Pi 서버에 기능 재구현 | 이미 있는 registry/remote/vault/control을 버리고 새 host에 중복 이식한다. 관측된 문제 해결에 필수적이지 않다. |

GUI-only에서도 terminal-capable worker를 쓰는 선택은 TUI 재작성 비용을 피하는 대신 PTY/zmx/TUI 상태 비용을 가진다. 기존 RPC worker 대비 총 RSS/CPU를 재야 한다. 이 비용이나 terminal handoff 동등성이 기준을 못 맞추면 이 선택을 재검토하며, 실패한 설계를 그대로 구현하지 않는다.

## 2. 확인된 사실과 철회한 주장

### 최적화 전 저장 목록 비용은 실제 문제였다

- 현재 profile: 483 JSONL, 736,255,621 bytes (약 702MiB).
- worker 자식이 없는 30.28초 운영 프로세스 표본: CPU 한 코어의 96.2%, RSS 약 829→945MiB.
- 별도 read-only 프로세스의 동일 이력 1회 조회: 모든 483 파일/736MB를 읽음, 2,532ms elapsed / 3,049ms CPU. 프로파일 상위는 session metadata 생성·문자열 디코딩·JSON 파싱이다.
- `SessionFiles.list → SessionManager.listAll → buildSessionInfo`가 전체 본문을 매번 파싱한다. `resolve`도 전체 list를 다시 부른다. [session-files.mjs](../../harness/pi-server/src/session-files.mjs), [host.mjs](../../harness/pi-server/src/host.mjs).
- 실제 metadata 변화 없는 text delta 250개가 directory revision 250개를 만든다. 저장 세션 1개/500개일 때 관측 burst 비용 4.57ms/223.67ms. **Chord는 같은 공개 sessions 배열 참조를 유지했으므로 전체 목록이 매번 전송된다고 주장하지 않는다.**

96.2% CPU 전부가 목록 때문이라는 live A/B는 하지 않았다. 2.53초 pass와 2초 setInterval만으로 100% duty cycle이 증명되지 않는다. RSS 변화만으로 leak이라고 판정하지 않는다.

### 이중 writer는 정상 append만으로 기본 분기를 갈라놓는다

독립된 두 SDK probe 모두 같은 결과다. 같은 JSONL을 읽은 A/B가 각자 append하면 파일의 7줄은 남지만 마지막 leaf의 parent walk는 B의 대화만 따라가고 A의 대화가 기본 화면/context에서 빠진다. 원본 bytes가 사라졌다는 주장은 철회한다. 실제 truncate/rewrite는 구버전 migration·빈 파일 초기화 등 별도 전제가 있다.

따라서 lock은 append 한 줄 동안만 잡는 것이 아니라 **해당 대화를 hydrate한 AgentSession의 쓰기 수명 전체**를 보호해야 한다. leaf를 읽어 비교하는 것만으로는 check→append 경쟁이나 이미 만들어진 모델 context의 stale 상태를 막지 못한다.

### 매핑 schema는 있지만 현재 stock adapter는 일부를 채우지 못한다

hub protocol은 이미 `pi.{sessionId, sessionFile, leafId}`를 갖고 snapshot을 registry에 반영한다. “매핑이 없다”는 초기 결론은 틀렸다. 단, schema 존재가 설치본 값의 완전성을 뜻하지 않는다.

설치된 stock Pi SDK + 실제 stock-control adapter를 격리 profile에서 실행한 결과:

- SDK sessionFile 식별자는 있음 → control snapshot의 sessionFile은 없음.
- `newSession`, `fork`, `reload`는 event context에 해당 기능이 없어 unavailable.
- adapter의 `respondToUiRequest`는 상수 false이며 uiRequest는 undefined다.
- 레거시 Senpi transform에는 더 풍부한 native control이 있지만 현재 stock install에서 같은 연결을 확인하지 못했다.

원인: factory가 session 옵션 없이 설치되고, stock adapter가 일반 event context를 command context처럼 사용한다. [bootstrap.mjs](../../harness/pi-runtime/features/rubato-components/bootstrap.mjs), [stock-control.mjs](../../harness/pi-runtime/features/remote-surface/stock-control.mjs). 설치본 probe는 모델/TUI 렌더를 실행한 시험이 아니다.

### stock 런타임에는 전환 소유자가 따로 있다

설치된 `AgentSessionRuntime`은 `AgentSession` 및 cwd-bound services의 교체를 소유하고, `InteractiveMode`는 그 runtimeHost에 연결된다. stock `switchSession`은 대상 SessionManager를 연 다음 기존 session을 abort/dispose하고, 이후 새 runtime을 만든다. **새 runtime 생성 실패 시 이전 실행을 그대로 유지하는 트랜잭션이 아니다.** extension event context에 몇 개 메서드를 덧붙이는 수준으로 이 문제를 해결했다고 볼 수 없다.

또한 `/resume` selector의 rename은 `SessionManager.open(...).appendSessionInfo(...)`를 직접 호출한다. 입력/모델 turn만 fence를 적용하면 이 별도 writer를 놓친다. 서비스의 empty-session create, migration, fork/import와 함께 쓰기 진입점 목록에 포함한다.

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

## 7. 저장 목록 설계 — 독립적인 첫 구현 단위

외부 목록 필드(title/messageCount/created/modified/cwd/id)와 원본은 그대로 유지한다. T3 subscription 전환/새 프로토콜/worker 통합을 이 수정의 선행조건으로 만들지 않는다.

1. 기존 `session-catalog`의 discovery/page 규칙을 검토해 재사용한다. 현재 helper는 page 단위 본문 parse를 줄이지만 permanent metadata cache는 아니며, transcript-cache는 TUI progressive renderer이므로 그대로 가져오면 문제를 해결하지 못한다.
2. canonical file identity + inode/dev + size + mtime/ctime fingerprint로 metadata cache. profile 밖 symlink는 기존 보안 계약대로 제외. 글로벌 제한된 IO 동시성, 초기 상태부터 오류를 파일 단위로 격리한다.
3. slim streaming parser는 기존 metadata 의미론을 재현하되 사용하지 않는 allMessagesText를 만들지 않는다. title clear, 첫 user text, message count, modified 기준은 기존 SDK와 differential test한다.
4. 변경 없는 warm list는 JSONL open/parse 0. `resolve(id)`는 같은 index에서 찾되 missing/ambiguous/changed 상태를 정확히 처리한다. create는 만든 한 항목만 invalidation/upsert한다.
5. 첫 단계는 안전하게 **변경 파일 재파싱**. append-tail 최적화는 실제 필요가 확인된 후 추가한다. size 증가만으로 append임을 추정하지 않는다. overwrite/truncate/rename/부분 JSONL line, parse 중 파일 변경을 처리하고 잘못된 캐시를 확정하지 않는다.
6. 처음에는 기존 poll을 경량 readdir/stat invalidation에 사용해 호환성을 유지한다. watcher는 dirty hint일 뿐 유일한 정확성 근거가 아니다. watcher 유실/restart 시 bounded reconciliation이 복구한다.
7. 내부 catalogue와 runtime summary를 분리하고 실제 표시 필드 변화 때만 Directory revision을 올린다. 기존 wire 응답 모양은 유지할 수 있다. text delta는 session stream에만 간다.
8. cold start의 대형 단일 파일 비용도 따로 측정한다. 단순 cache로도 기준을 못 맞추면 rebuildable on-disk metadata cache 또는 lazy page를 비교한다. 새 대화 DB가 아니라 삭제해도 복구되는 파생 cache다. 목록 페이지/순서 변경은 별도 사용자 관측 변경으로 취급한다.

## 8. 원본 보존 이행 순서와 정지 조건

| 단계 | 산출물 / 범위 | 통과 조건 |
|---|---|---|
| 0 | 현재 CLI 관측 계약 + fixture/측정 유지 | picker/boot/new/attach/list/vault/exit75 기준, 실제 PTY capture 추가. 기존 자동 시험만으로 렌더 동등성을 선언하지 않음. |
| 1 | 위 metadata index + no-op publish | unchanged warm list JSONL reads0, 변경 한 파일만 parse, metadata differential, polling CPU/RSS 전후, 재시작/corrupt/symlink/삭제 검증. T3/worker 정책 변경 없음. |
| 2 | 격리 control/fence/terminal-handoff feasibility | 현재 stock pin으로 standard UI 양방향, session epoch 전환, 같은 프로세스 동시 CLI/T3 control, 아래 G1/G2 통과. live 설치는 건드리지 않음. |
| 3 | common service acquire/worker/attachment 도입 | CLI-first 및 GUI-first 모두 same workerId, same logical branch. 신규 세션부터 opt-in, 구버전 live owner 보호. |
| 4 | T3 binding/이벤트를 공통 control로 전환 | history/stream/reconnect/late reply/질문/model/effort/도구/large payload parity. 별도 Pi worker spawn 제거. |
| 5 | 중복 host/TTL/poll 제거, 배포 전 검증 | remote/vault 동등성, 실측 개선, 고장 주입/롤백, 다른 machine 설치. 이후에만 기본 경로 전환. |

단계1은 설계가 충분히 구체적이다. 전체 공통 엔진 통합은 다음 두 gate를 통과하기 전 큰 구현을 시작하지 않는다.

**G1 — control + ownership**: 실제 stock build를 사용하는 격리 worker에서 CLI/remote 입력, standard 질문/확인, abort, resume/fork/reload, epoch에 묶인 late response, 프로세스 pause/crash, 동시 acquire와 branch 보존. 전환 중 runtime 생성 실패, T3 A binding 보존, selector rename 및 extension `withSession`도 포함한다. SDK in-process mock만 통과하면 부족하다.

**G2 — terminal-capable worker 비용 + handoff**: GUI-first로 뜬 worker에 CLI attach해 PID/worker/branch가 그대로인지; A의 `/resume`가 이미 살아 있는 B로 갔을 때 CLI view/attachment 이동 범위가 기존 의미와 맞고 대상 B 연결 및 T3 작업을 건드리지 않는지; terminal 없는 동안 TUI animation/render가 CPU를 쓰지 않는지. 기존 RPC 대비 process-tree RSS/CPU/FD와 cold/warm latency를 함께 비교한다. synthetic zmx client 교체 통과만으로 G2 전체를 닫지 않는다.

G1/G2가 실패하면 이유를 설계로 환류한다. GUI read-only/auto-fork나 새 TUI를 몰래 대체안으로 도입하지 않는다. 별도 모델 리뷰를 추가하지 않고 리드가 직접 이어가라는 사용자 지시를 따른다.

## 9. 완료 기준 / 현재 미확인

완료는 클래스 수나 daemon 이름이 줄어드는 것이 아니라 다음 제품 결과다.

- 동일 대화가 CLI/T3에서 하나의 worker/leaf owner를 공유한다. 동시 입력은 같은 진행 context에 들어가고 잘못된 thread로 전송되지 않는다.
- 저장 이력 개수/총 bytes 증가가 idle CPU 및 토큰당 전체-catalogue 비용으로 곧장 번지지 않는다.
- 화면을 닫아도 실행/질문은 정해진 정책대로 살아 있고, 보이지 않는 idle engine은 불필요하게 유지되지 않는다.
- 기존 CLI 외형/입력/부팅/피커/resume/remote/vault와 기존 T3 기능을 실제 표면에서 확인한다.
- 서비스/worker crash/restart, unknown command outcome, 구버전 생존/전환, malformed/큰 파일, alias/중복 UUID를 시험한다.

설계 단계 baseline은 CLI40, Pi15(+실제 candidate 1skip), T314, lead remote-surface9 시험과 격리 SDK/OS primitive 관측, 실제 zmx의 synthetic client 교체다. 공통 소유권 원칙과 목록 최적화 단위는 정리됐지만 worker 전환 세부까지 확정한 설계는 아니다. **전체 통합, 실제 `/resume` handoff, standard UI parity, 실제 제품 렌더 동등성은 여전히 미확인이다.** 이후 승인된 제품 코드 변경과 검증은 아래 §10에 기록한다. 설치본·사용자 세션 변경, commit/push/deploy는 하지 않았다.

## 10. 승인 후 첫 구현 — 기존 연결/사용 방식은 유지

사용자 승인: "ㅇㅇ 리소스 최적화 최대한 진행해보자 너가 직접 해줘. 기존 동작이나 사용방식을 해치지 않으면서 내부 엔진 붙는 것만 바꾸면 될거같은데". 리드가 직접 구현했고 추가 에이전트는 사용하지 않았다.

- `SessionFiles`: canonical path 및 dev/inode/size/mtimeNs/ctimeNs/mode cache, 동일 scan 공유, 폴더 전체를 합친 조회 IO 동시성 10. warm list/resolve는 본문을 다시 읽지 않는다. create는 생성한 한 파일만 읽어 등록한다.
- `session-metadata.mjs`: pinned Pi metadata 의미론을 재현하는 read-only streaming parser. 검색에 쓰지 않는 전체 대화 문자열을 누적하지 않는다. 첫 user text, latest title/clear, message count, activity time과 기존 폴더별/전체 정렬을 보존한다.
- 변경 파일은 전체를 다시 읽되 시작 시점 size로 읽기를 제한한다. 읽는 동안 바뀐 파일을 완성된 cache로 인정하지 않는다. append-tail 추정, watcher, 새 DB, 원본 migration은 추가하지 않았다.
- `host`: text delta는 session stream으로 그대로 전달하고 상태가 달라질 때만 목록을 갱신한다. 전체 목록 비교 후 실제 표시 필드가 같으면 revision/publish를 생략한다. attachment/running/waiting/idle 변화는 계속 전달한다.
- 목록만 사용하는 프로세스는 agent/TUI/provider SDK를 로드하지 않는다. public SDK는 create/transcript 때 지연 로드하며, 원본 writer API와 transcript 의미론은 유지한다.

최종 회귀검사: **Pi server 27/27, T3 bridge/실제 driver·projector 계약 14/14, CLI 40/40**. Pi 검사에는 실제 설치 stock candidate를 격리 profile에서 시작·resume하는 시험이 포함돼 skip이 없다. 유료 모델 호출/실제 TUI 조작 시험은 아니다. 기존 Pi와 160개 생성된 정상/손상 조합을 differential test했고, timestamp의 sub-ms 반올림과 비정상 날짜의 폴더별 정렬 차이를 발견해 기존 결과에 맞췄다.

실측 원장은 `_workspace/runtime-architecture-20260915/real-index-final-{legacy,optimized}.json`, `event-fanout-after.json`, `host-import-{before,after}.json` 및 `resource-optimization.md`다. 재현 방법은 [측정 절차](PERFORMANCE_MEASUREMENT.md)를 따른다. 이 단계는 목록/갱신 비용 개선이며 이중 writer 방지나 CLI/T3 단일 worker 통합을 완료한 것이 아니다. 실행 중인 기존 서버를 재시작하지 않았으므로 live 적용 결과와 구분한다.

같은 483개/736,255,621 bytes 이력에서 metadata 결과 hash는 모두 일치했다. 변경 전 조회 2회 중앙값 **2,376.151ms → warm 5회 중앙값 7.654ms**, warm JSONL 읽기 **483개/736MB → 0개/0bytes**. 첫 cold 조회는 **2,388.232ms**로 여전히 전체 parse 비용이 남는다. 격리된 현재 host의 30초 대기 측정은 한 코어 CPU **1.154%**, poll14회 동안 본문 read0/revision0/worker0이었다. 기존 live 프로세스의 CPU가 실제로 내려갔다고 주장하지 않는다.
