# CP3 — 재시작과 프로세스 소유권

이 체크포인트에는 실행 가능한 `src/cli.mjs`, 프로필당 서버 하나를 보장하는 잠금, 재시작 후 유지되는 서버 주소 파일, 읽기 전용 저장 이력 조회, 실제 Rubato 실행기에 묻는 모델/명령 목록 조회를 추가했다. 주소 파일은 대화 저장소가 아니다. 모델 조사용 임시 세션은 사용자 세션 목록 밖에 만들고 즉시 정리한다.

소켓은 공식 Unix transport와 0600 권한을 사용한다. T3 종료나 연결 해제는 worker 종료가 아니다. 서버 자체가 종료되면 서버가 소유한 worker는 종료하며 저장 이력으로 재개한다. 재접속 시 모델 요청을 자동 재전송하지 않는다.

프로토콜 오류가 발생해도 실제 child close 전에는 terminated를 해결하지 않는다. SIGTERM을 무시하는 시험 프로세스까지 종료한 후 ESRCH를 확인했다. snapshot은 get_messages 응답을 읽은 바로 그 순간의 이벤트 순서를 반환하여 같은 입출력 묶음 뒤에 온 사건을 건너뛰지 않는다. 서버가 비정상 종료되면 IPC disconnect를 받은 worker도 종료하도록 preload를 추가했다. 이 IPC 강제 종료 경로는 아직 별도 SIGKILL 통합검사를 실행하지 않았으므로 정상 종료/재시작 검사와 구분한다.

실행 명령 (Node 24.20.0, Linux):

```sh
RUBATO_TEST_CANDIDATE=/mnt/data/rubato-work/candidate \
node --test --test-timeout=45000 harness/pi-server/test/*.test.mjs
```

이번 로컬 실행은 8개 통과, 실패/취소/건너뜀 0, 종료 코드 0이었다. 로컬에는 CP2a의 원격 단독 저장 파일 검사가 아직 내려오지 않았으므로 원격 전체 검사 개수와 다를 수 있다. 실제 Rubato candidate의 세션/명령 조회 한 건을 포함하며 나머지 실행 작업에는 명시적인 시험용 agent/model child를 사용한다. 실제 모델 API 호출 성공을 뜻하지 않는다.

새 세 가지 검사는 서로 다른 소켓을 쓴 같은 프로필의 중복 서버 거부, 서버 재시작 후 동일 serverId 및 저장 이력 복구, 잘못된 RPC 출력의 실제 프로세스 정리, snapshot/event 순서 경계를 확인한다. 모델 조사 후 저장 세션 목록 개수가 바뀌지 않는 것도 확인했다.

현재 한계: 이 서버가 시작한 Rubato 작업에는 여러 화면이 붙을 수 있다. 서버 밖에서 독립적으로 이미 실행 중인 구형 TUI 프로세스를 임의로 가져오거나 그 프로세스의 표준 입출력을 탈취하지 않는다. 그런 세션을 동시 쓰기 대상으로 여는 지원은 완료했다고 주장하지 않는다.

프로필 잠금은 이미 Pi 의존성에 있는 proper-lockfile 4.1.2를 직접 고정해 재사용한다. https://github.com/moxystudio/node-proper-lockfile 의 문서에 따라 동일 stale/update 정책을 사용하고 잠금 상실 시 서버를 닫는다.
