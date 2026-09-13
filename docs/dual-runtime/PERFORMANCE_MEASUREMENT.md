# Dual-runtime 성능 비교 절차

이 문서는 `Codex Desktop + rubato-codex`와 `T3 + Pi server + rubato-pi`를 같은 제품 수준까지 올린 뒤 비교하기 위한 측정 절차다. 현재 단계에서 어느 쪽이 더 빠르거나 가볍다고 결론내리지 않는다.

## 자동으로 남기는 Pi control-path 지표

`harness/pi-server/scripts/measure-lifecycle.mjs`는 실제 Rubato CLI의 Pi server/client/process 수명주기를 사용하고 모델 대신 결정적인 시험용 child process를 연결한다. 따라서 다음 수치는 세션 관리 비용을 재현하는 용도이며 모델 추론/첫 토큰 시간은 포함하지 않는다.

```sh
npm --prefix harness/pi-server install --ignore-scripts --workspaces=false
node harness/pi-server/scripts/measure-lifecycle.mjs
```

출력 JSON에는 다음이 들어간다.

- 서버 시작 + 화면 연결 시간
- 저장 세션 100개 목록 조회 시간과 그때 생성된 runtime 수
- 저장 세션의 첫 attach 시간
- 같은 runtime에 다시 붙는 warm attach 시간과 runtime 유지 여부
- 다른 세션으로 전환하는 시간
- 두 runtime이 로드된 시점의 부모 프로세스 RSS 참고값
- 서버 재시작 후 저장 세션 목록 복원 + attach 시간
- 재시작 전 runtime 시작 횟수

CI의 `dual-runtime-validation` 산출물에 `pi-lifecycle-measurement.json`을 함께 보존한다. CI 호스트 변동이 크므로 절대값 한 번으로 제품 결론을 내리지 않는다.

## 완제품에서 별도로 재야 하는 지표

같은 컴퓨터와 같은 저장소, 같은 모델/추론 강도, 같은 입력을 사용해 각 경로에서 최소 5회 반복하고 중앙값과 범위를 기록한다.

| 지표 | Codex 경로 | T3/Pi 경로 |
| --- | --- | --- |
| 앱/서버 cold start | Codex Desktop 완전 종료 후 시작 | T3 + Pi profile server 완전 종료 후 시작 |
| 새 thread 화면 생성 | 새 thread 선택부터 입력 가능까지 | 새 thread 선택부터 입력 가능까지 |
| warm session attach | 이미 살아 있는 실행 세션 재선택 | 이미 살아 있는 Pi runtime 재선택 |
| cold stored resume | 종료된 저장 thread 열기 | 저장된 Pi JSONL 세션 열기 |
| session switch | A↔B 반복 | A↔B 반복 |
| idle sessions N개 RSS | 저장 thread만 N개 | 저장 Pi session만 N개 |
| active sessions N개 RSS/CPU | 동시에 실제 작업 N개 | 동시에 실제 Pi worker N개 |
| first event/token | 전송부터 첫 assistant event | 전송부터 첫 assistant event |
| background 유지 비용 | 화면을 다른 thread로 옮긴 상태 | T3 detach 후 Pi runtime 유지 상태 |
| crash/restart recovery | 앱/서버 강제 종료 후 복구 | T3 및 Pi profile server 각각 강제 종료 후 복구 |
| upstream 갱신 비용 | 한 버전 업데이트에 필요한 Rubato 수정 | Pi/T3 업데이트에 필요한 adapter 수정 |

첫 토큰 비교에는 동일한 외부 모델 인증과 동일한 프롬프트가 필요하다. 현재 자동 검사는 유료 모델 호출을 하지 않으므로 이 항목은 로컬 실제 계정 검증으로 남긴다.

## 해석 규칙

저장 세션 목록 조회만으로 runtime이 생기면 Pi 경로의 실패로 본다. 실행 중 세션에서 UI를 떼었다 다시 붙였을 때 runtime 식별자가 바뀌어도 실패다. 반대로 idle + attachment 없음 상태의 runtime이 정책에 따라 정리되는 것은 정상이다.

두 경로 중 하나를 canonical runtime으로 정하는 판단은 위 실제 계측과 사용감 비교 뒤에만 한다.
