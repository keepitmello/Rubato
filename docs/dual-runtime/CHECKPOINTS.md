# 두 실행 경로 통합 작업의 체크포인트

## CP0 — 2026-09-13 작업 재개

- 사용자의 최초 지시: Codex 경로 감사 → 필요한 최소 수정 → 공식 Pi 조사 → Pi 서버/세션 연결 → 수명주기 검증 → T3 조사/제공자 연결 → 통합 검증 → PR 및 변경 파일 ZIP.
- 사용자 승인: 위 범위의 구현을 진행하며 체크포인트마다 반드시 원격에 저장한다. 두 실행 경로를 유지한다.
- 이번 작업의 기준: `rubato/base`의 `215b0432a2bb672690203dff8b5ad423d17020df`.
- 새 작업 브랜치: `codex/dual-runtime-checkpoints-20260913`.
- 이전 브랜치 `codex/pi-server-t3-integration-20260913`는 `3c9c5c41af1624cf240221d62dbffc5bdd7502ff`에 그대로 보존한다. 덮어쓰거나 강제로 이동하지 않는다.

### 이번에 직접 확인한 상태

샌드박스 `/mnt/data`를 실제 조회했다. 기존 구현 작업 디렉터리는 없으며 아래 다섯 원본 압축 파일과 최초 지시 문서가 있다.

| 파일 | 크기(바이트) | 압축 목록에서 확인한 내용 |
| --- | ---: | --- |
| rubato-validation-bundle.zip | 220150992 | REVISION, node, pi-sdk-deps.tar.gz, pi-server-deps.tar.gz, rubato-source.tar.gz |
| pi-server-integration-evidence.zip | 77427834 | node, package-lock.json, rubato-source.tar.gz, server-dependencies.tar.gz |
| pi-server-runtime-evidence.zip | 269535540 | bun, node, package-lock.json, rubato-source.tar.gz, runtime-dependencies.tar.gz, server-dependencies.tar.gz |
| t3-pinned-source.zip | 99741474 | t3-source.tar.gz |
| t3-contract-deps.zip | 20199516 | t3-contract-deps.tar.gz |

이것은 파일 존재와 압축 목록의 확인이다. 앞선 대화에서 주장한 미커밋 구현, 32개 시험 통과, 전체 복원 완료는 이번 작업의 검증 결과로 사용하지 않는다. 새로 작성한 구현과 복원한 원본을 구분한다.

샌드박스의 공개 네트워크 요청은 DNS 해석에 실패했다. GitHub 연결의 실제 읽기와 새 브랜치 생성은 성공했다. 로컬에서 실행하지 못한 검증은 실행했다고 쓰지 않는다.

### 유지할 결정

1. Codex Desktop/runtime을 재작성하거나 패치하지 않는다. 중복/오류가 코드에서 확인될 때만 수정한다.
2. Pi의 공식 session/server 계층을 좁은 연결부 뒤에서 재사용한다. 별도 대화 저장소나 중복 세션 관리자를 만들지 않는다.
3. Rubato의 Taskforce, 모델 선택, 메모리, 스킬 및 제품 정책을 유지한다.
4. T3는 화면/조작 및 표시용 기록을 소유하고, 실제 Pi 세션/실행기의 소유권을 가져가지 않는다.
5. 실행 중 화면 연결이 끊겨도 작업을 유지한다. 저장 세션 목록 조회만으로 실행기를 생성하지 않는다.
6. T3 핵심 구조의 장기 분기, 저장 형식 변경, 기존 동작을 깨는 결정이 필요하면 문제와 대안을 기록하고 해당 범위만 설계 검토로 돌린다.

### 남아 있는 작업

- [ ] CP1: 현재 저장소 조사와 Codex 감사표.
- [ ] CP2: 공식 Pi 채택표, 서버/세션 연결과 최소 시험.
- [ ] CP3: 실제 Rubato Pi 실행기 연결과 다중 세션 수명주기 검증.
- [ ] CP4: T3 현재 구현 조사와 제공자 연결.
- [ ] CP5: 기존/실행 중 세션, 재접속, 입력/도구/질문/중단 통합 검증.
- [ ] CP6: 전체 검증 기록, 인수인계, PR와 변경 파일 ZIP.

각 체크포인트에서 구현 파일과 검증 기록을 먼저 원격에 저장하고 다음 단계로 이동한다. 로컬 커밋만으로 저장 완료라고 보고하지 않는다. 중간에 검증이 실패해도 진행 중 상태를 명시하여 별도 작업 브랜치에 저장한다. 기본 브랜치는 수정하지 않는다.
