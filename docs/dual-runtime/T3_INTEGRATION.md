# CP4a — T3 연결부와 실제 사건 계약 검사

조사한 현재 T3 HEAD는 `cfeaca41ae27bdf2c203158d378c87c7308fea2a`다. 샌드박스에 보존된 `18d8cbfd920d0a53e5b5206456585aea767e852c`에서 6개 커밋이 진행됐으며 GitHub compare로 제공자·계약·서버 시작 파일에 변경이 없는 것을 확인했다. 모든 T3 소스가 최신이라고 확대하지 않는다.

T3의 `ProviderDriver`는 열린 식별자를 사용하고 `builtInDrivers.ts` 등록으로 제공자를 추가할 수 있다. `ProviderSessionDirectory`는 기존 SQLite에 resumeCursor와 thread 대응을 보존한다. 새 세션 DB를 만들 필요가 없다. 기존 AgentSessionScanner의 자동 파일 가져오기는 Claude/Codex에 한정되므로 Pi 저장 목록은 별도 얇은 표시 연결에서 기존 project.create/thread.create/thread.history.import 명령으로 옮긴다. 코어 오케스트레이터를 다시 만들지 않는다.

관련 PR #10474 (`feat(pi): add pi provider via RPC`, 종료·미병합)도 조사했다. 제공자·RPC·승인 확장과 시험용 실행기까지 추가하는 큰 변경이며 main에 들어온 기능이 아니다. 이번 경로는 T3가 매번 Pi 프로세스를 소유하는 그 구조를 그대로 채택하지 않고 이미 실행 중인 Rubato Pi Server에 붙는다.

CP4a에는 `src/bridge.mjs`, `src/events.mjs`와 네 가지 검사를 저장한다. ProviderDriver 등록과 sidebar 연결은 아직 다음 체크포인트 작업이다. 전체 T3 GUI 완료라고 주장하지 않는다.

실행:

```sh
T3_SOURCE=/mnt/data/rubato-work/t3/t3code-18d8cbfd920d0a53e5b5206456585aea767e852c \
node --test --test-timeout=45000 harness/t3-integration/test/bridge.test.mjs
```

Node 24.20.0 / 실제 Effect 4.0.0-rc.112 및 T3 ProviderRuntimeEvent 스키마로 4개 통과, 실패 0, 건너뜀 0, 종료 코드 0. 공식 Pi Server/Client/Unix 연결은 실제이며 에이전트/모델은 명시적인 시험용 child process다. 이 결과는 전체 T3 앱·브라우저·실제 모델 호출 성공이 아니다.

검사한 내용: 저장/실행 중 목록, 기존 실행기에 중복 없이 붙기, T3 stop이 화면 연결만 해제하는지, 새 세션 생성, 질문 전달/응답, 연결 재수립 후 같은 runtimeId, 본문/추론/도구 시작·갱신·완료/확인 요청/정상 종료의 T3 형식, 재접속 때 기존 출력에 전문을 중복 추가하지 않는지.

현재 지원 범위를 명시적으로 좁힌 부분: T3 파일/그림 첨부, 계획 모드, 되감기는 아직 지원하지 않는다. T3의 승인 필요/자동 편집 모드를 실제로 강제하는 정책은 기존 Rubato에 없으므로 full-access 이외 모드는 거부한다. 기존 Rubato 확장이 요청하는 선택·입력·확인 질문을 전달하는 것과 T3의 별도 실행 권한 정책을 구현하는 것은 다른 기능이다. 한 번 승인만 전달하며 영구 승인을 가장하지 않는다.

공식 근거:
- https://github.com/pingdotgg/t3code/blob/cfeaca41ae27bdf2c203158d378c87c7308fea2a/apps/server/src/provider/ProviderDriver.ts
- https://github.com/pingdotgg/t3code/blob/cfeaca41ae27bdf2c203158d378c87c7308fea2a/apps/server/src/provider/Services/ProviderSessionDirectory.ts
- https://github.com/pingdotgg/t3code/pull/10474
