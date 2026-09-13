# CP2b — 공식 서버와 다중 세션 검증

현재 소스로 빌드한 Rubato candidate와 공식 Pi 0.85.1 Server/Client/Chord/Unix transport를 연결했다. checkpoint CP2a 위에 host/client와 통합 검사를 추가했다.

```sh
PATH=/mnt/data/rubato-work/bin:$PATH \
RUBATO_TEST_CANDIDATE=/mnt/data/rubato-work/candidate \
node --test --test-timeout=45000 harness/pi-server/test/integration.test.mjs
```

2026-09-13, Linux, Node 24.20.0: 5개 통과, 실패 0, 취소 0, 건너뜀 0, 종료 코드 0. 마지막 실행 시간 8463.178153ms.

- 100개 실제 Pi 저장 파일 목록을 조회해 runtimeStarts=0을 확인했다. 없는 ID에 attach해도 새 파일/실행기가 생기지 않았다.
- A 실행 시작 → 화면 연결 해제 → B 실행 → A에 두 client가 동시에 재연결 → 연결 재수립까지 동일 runtimeId를 확인했다. A/B의 실행기 시작은 총 2회였다.
- 실행 중이거나 연결이 남은 세션의 unload를 거부했다. 중단 후 마지막 연결이 떠나면 실행기를 정리했고, 다시 열 때 새 runtimeId와 기존 대화 내용을 확인했다.
- 질문을 표시한 채 연결을 끊어도 질문/실행기가 유지됐다. 제시하지 않은 선택지와 중복 응답을 거부했다.
- 다른 client가 만든 세션이 directory 구독에 표시됐고 실행기는 만들지 않았다.
- 실제 Rubato candidate 프로세스를 띄워 저장 세션 열기, snapshot, get_commands를 공식 서버를 거쳐 검사했다.

첫 네 검사의 에이전트 실행/모델은 명시적인 시험용 child process다. 소켓, 공식 서버/클라이언트, 파일시스템, SessionManager는 실제 구현이다. 마지막 검사는 실제 Rubato 프로세스와 확장 묶음을 사용하지만 모델 API는 호출하지 않았다. 따라서 유료 모델 출력/실제 도구/계정 인증까지 검증한 것은 아니다.

첫 시행의 A 유지 검사는 시험용 모델이 350ms 만에 완료돼 B를 시작하는 동안 정리되는 정상 동작과 충돌했다. A의 시험 작업을 10초로 늘리고 명시적으로 abort하도록 바꿨다. 실행 중 유지 정책을 느슨하게 바꿔 통과시킨 것이 아니다.

CLI 프로필 설정, 프로세스 복구 및 T3 통합은 다음 체크포인트에서 다룬다. 지금 코드만으로 T3 완제품이 됐다고 주장하지 않는다.
