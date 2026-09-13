# 공식 Pi 재조사와 채택 결과

2026-09-13. Rubato가 고정한 Pi 버전은 `0.85.1`이다. 공식 `earendil-works/pi` `main`은 최종 재확인 시 `71dca871bc80b6bc97be37f0ca3189399d651fff`였고 `packages/server/package.json`도 0.85.1이다. 과거 문서의 `PiServerService`를 가정하지 않고 현재 배포된 Server/router/client 코드와 source-only experimental 계층을 구분해서 조사했다.

## 채택표

| 판정 | 기능 | 결정과 이유 |
| --- | --- | --- |
| ADOPT | pi-server `Server` / `SessionRouter` | 실행 핸들 획득을 중복 방지하고 server/session/attachment 주소를 검사하는 공식 경로를 사용한다. |
| ADOPT | pi-client, pi-protocol, Chord | 연결, 구독, 상태 복제, 오래된 연결 차단과 공식 reconnect 경로를 재사용한다. 프로토콜 버전은 고정 배포본에 맞춘다. |
| ADAPT | 저장 목록/생성 | public `SessionManager`와 기존 JSONL을 사용한다. 목록 조회만으로 실행기를 만들지 않는다. 빈 대화는 SDK가 만든 header만 저장해 재시작 뒤에도 발견되게 한다. |
| ADAPT | application-owned runtime handle | 공식 server가 요구하는 open/attach/invoke/release/close/terminated 경계 뒤에 기존 `rubato-pi --mode rpc` 프로세스를 둔다. 화면 연결이 끊겨도 실행 중 작업은 유지한다. |
| ADAPT | RPC transport | 공개 RPC API에 없는 extension UI response/프로세스 종료 경계만 얇게 보완한다. 도구·대화·모델 의미론은 기존 Rubato 실행기에 남긴다. |
| REFERENCE ONLY | experimental SessionDirectory / SessionManagement / AgentHarness | coding-agent 배포 package에서 안정 public surface로 노출된 계층이 아니다. source-only API를 Rubato 전체에 퍼뜨리지 않는다. |
| SKIP | native Taskforce/모델/메모리/스킬 대체 | Rubato 제품 정책과 역할 배치를 유지한다. 최신 기능이라는 이유로 교체하지 않는다. |

## 수명주기 의미론

공식 router는 한 connection에 한 session attachment를 둔다. 같은 session에 여러 client를 붙일 수 있으며 여러 화면이 동시에 필요하면 connection을 분리한다.

같은 session을 동시에 열어도 공식 router와 Rubato host가 하나의 live runtime handle을 공유한다. 화면 detach는 attachment만 해제한다. `running + no attachment`는 작업이 끝나기 전 닫지 않는다. `idle + no attachment`는 Rubato의 idle 정책으로 unload할 수 있다.

저장 세션 목록은 JSONL/`SessionManager.listAll`만 읽는다. 100개 저장 세션을 조회해도 runtime을 생성하지 않는 것을 통합시험과 계측 양쪽에서 확인했다. 재연결은 새 attachment와 snapshot/state 구독으로 화면을 다시 구성한다. worker가 실제로 사라진 경우에만 저장 session으로 새 runtime을 만들며, 중단된 모델 요청을 자동 재전송하지 않는다.

## 구현 경계

```text
Rubato/T3 presentation
        ↓
harness/pi-server client + host
        ↓
official Pi Server / SessionRouter / Chord / Unix transport
        ↓
RpcWorker
        ↓
existing harness/rubato-pi --mode rpc
        ↓
Rubato Core / extensions / model routing
```

이 서버는 자신이 시작한 worker만 소유한다. 서버 밖에서 이미 독립 실행 중인 과거 TUI 프로세스의 stdio를 탈취해 가져오지 않는다. 대신 Pi server를 통해 이미 실행 중인 session에는 여러 presentation client가 중복 worker 없이 붙을 수 있다.

## 최종 자동 검증

Node 24.20.0/Linux의 GitHub Actions에서 Pi server 시험은 총 10개 중 9개 통과, 실패 0, 건너뜀 1이다. 건너뜀은 별도 `RUBATO_TEST_CANDIDATE`가 필요한 실제 빌드 candidate smoke다. 이전 로컬 검증에서는 이 candidate 경로를 실제 Rubato 프로세스로 실행해 session/snapshot/get_commands 제어 경계까지 확인했다. 유료 모델 호출은 하지 않았다.

현재 자동 검사가 확인하는 항목은 다음과 같다.

- 저장 세션 100개 목록 조회 시 runtime 0개
- 없는 ID attach가 session/runtime을 만들지 않음
- A 실행 → detach → B 사용 → A 동시 재연결 → 같은 runtime 유지
- running/attached session unload 거부와 idle cleanup
- abort 후 cold resume에서 기존 대화 복원
- 질문이 detach/reconnect를 넘어 유지되고 허용되지 않은 답/중복 답을 거부
- 다른 client의 session 생성이 directory 구독에 반영되며 worker는 생성하지 않음
- 명시적 transport disconnect 뒤 client cleanup 멱등성
- 프로필 중복 소유 방지, serverId/저장 이력 재시작 복구
- 잘못된 child RPC 종료와 snapshot watermark 순서
- 빈 실제 Pi session이 worker 없이 새 directory view에 남음

성능 계측 스크립트는 같은 실제 server/client/process 경계와 결정적 fixture child를 사용한다. 최근 CI 표본에서는 저장 세션 100개 목록 조회 후 runtime 0개, warm attach에서 동일 runtime 유지가 확인됐다. 절대 시간은 CI 호스트 편차가 크므로 제품 우열 판단에 쓰지 않는다.

공식 근거:
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/server/README.md
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/server/src/session-router.ts
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/src/experimental/services/sessions.ts
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/package.json
