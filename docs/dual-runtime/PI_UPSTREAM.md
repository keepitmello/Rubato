# CP2a — 공식 Pi 재조사와 저장·실행 경계

2026-09-13. 현재 Rubato pin은 0.85.1이다. 공식 `earendil-works/pi` HEAD `71dca871bc80b6bc97be37f0ca3189399d651fff`와 `packages/server/package.json`도 0.85.1이다. 이전 버전 문서의 PiServerService를 가정하지 않고 배포된 Server와 실제 types/router/client 코드를 읽었다.

## 공식 기능을 가져오는 범위

| 판정 | 기능 | 결정과 이유 |
| --- | --- | --- |
| ADOPT | pi-server Server / SessionRouter | 실행 핸들 획득을 중복 방지하고 server/session/attachment 주소를 검사하는 공식 경로를 사용한다. |
| ADOPT | pi-client, pi-protocol, Chord | 실제 연결, 구독, 상태 복제, 오래된 연결 차단은 공식 구현을 재사용한다. 프로토콜 버전은 배포본 8이며 상위 호환성을 임의로 보장하지 않는다. |
| ADAPT | 저장 목록/생성 | 현재 Rubato의 public SessionManager와 기존 JSONL을 사용한다. 목록 조회에는 실행기를 만들지 않는다. 빈 대화도 재시작 후 보이도록 SDK가 만든 header만 배타적으로 저장한다. |
| ADAPT | application-owned runtime handle | 서버가 요구하는 openSession/attachClient/invokeService/release/close/terminated 경계 뒤에 기존 Rubato Pi RPC 프로세스를 둔다. 실행 중 화면이 끊겨도 유지한다. |
| ADAPT | RPC transport | SDK RpcClient의 공개 API에는 extension_ui_response 쓰기와 process termination 구독이 없다. private 필드를 쓰지 않고 얇은 입출력 연결부만 둔다. 도구/대화/모델 의미론은 기존 Rubato 실행기에 남긴다. |
| REFERENCE ONLY | experimental SessionDirectory / SessionManagement / AgentHarness | coding-agent 배포 package는 dist/experimental을 제외하고 관련 export도 source-only다. 기존 확장 체계와 저장 형식을 새 계층으로 옮기는 것은 이번 통합의 전제가 아니다. source-only 구현을 설치된 API처럼 import하지 않는다. |
| SKIP | native Taskforce/모델/메모리/스킬 대체 | 현재 Rubato 제품 정책과 역할 배치를 유지한다. 최신 기능이라는 이유로 교체하지 않는다. |

## 실제 수명주기

공식 router는 한 connection에 한 session attachment를 둔다. 같은 세션에 여러 client를 붙이는 것은 가능하다. 한 client 객체로 여러 세션에 동시에 붙는다고 가정하지 않는다. 여러 화면이 동시에 필요하면 연결을 분리한다.

같은 session에 동시에 open이 들어와도 router의 openingSessions/hostedSessions가 하나의 handle을 공유한다. detach는 해당 attachment를 release하며 handle을 자동 close하지 않는다. worker 수명과 idle unload 정책은 application 책임이다. idle + attachment 없음일 때만 close하고 terminated를 해결해 공식 router 캐시를 무효화한다. 진행 중 prompt의 완료를 기다리는 RPC를 쓰면 detach가 기다릴 수 있으므로 Pi의 preflight 승인 후 즉시 반환하는 prompt 계약을 사용한다.

재연결 시 기존 attachmentId는 유효하지 않다. 새 attach와 구독 snapshot으로 화면을 재구성한다. worker가 죽으면 live state는 없어지고 저장된 세션을 다시 연다. 모델 호출을 자동 재전송하지 않는다.

## 현재 저장한 구현과 검증 범위

CP2a는 저장 파일 adapter와 RPC process transport를 먼저 보존한 중간 체크포인트다. 서버 연결과 T3 완료를 주장하지 않는다. 실제 SDK로 빈 세션 생성→새 목록 조회를 실행했으며 messageCount=0인 동일 세션을 확인했다. 현재 Rubato 소스와 복원한 격리 의존성으로 buildRubatoCandidate를 실행하여 ready receipt와 candidateEntry를 만들었다. 이 결과가 모델 API 호출 성공을 뜻하지는 않는다. 새 자동 단위 검사는 이 커밋에서 추가했고 원격 결과 확인 전이다.

공식 근거:
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/server/README.md
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/server/src/session-router.ts
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/src/experimental/services/sessions.ts
- https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/package.json
