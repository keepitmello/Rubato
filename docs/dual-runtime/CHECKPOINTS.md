# 두 실행 경로 통합 작업의 체크포인트

> **2026-09-23 폐기.** Codex 레인(`rubato-codex`)은 쓰지 않기로 하고 레포에서 들어냈다.
> 이 문서는 그때의 작업 기록이고, 아래의 경로·명령은 더 이상 존재하지 않는다.

## 기준

- 최초 요구: Codex 경로 감사 → 필요한 최소 수정 → 공식 Pi 조사 → Pi 서버/세션 연결 → 수명주기 검증 → T3 조사/제공자 연결 → 통합 검증 → PR 및 변경 파일 ZIP.
- 구현 브랜치: `codex/dual-runtime-checkpoints-20260913`.
- 최종 문서 작성 시 병합 대상 `rubato/base`: `942c781cb4dfac5129b16108e4dd88bfa2bf3a74`.
- 이전 조사 브랜치 `codex/pi-server-t3-integration-20260913`는 별도 보존하며 강제로 이동하지 않았다.
- 각 복구/구현/시험 수정은 원격 커밋으로 즉시 저장했다.

## 유지한 설계

1. Codex Desktop/runtime을 재작성하거나 T3로 감싸지 않는다. 실제 중복/오류만 최소 수정한다.
2. Pi의 공식 server/router/client/Chord 계층을 좁은 연결부 뒤에서 재사용한다. 별도 대화 저장소나 두 번째 session manager를 만들지 않는다.
3. Rubato의 Taskforce, 모델 선택, 메모리, 스킬, 역할 및 제품 정책을 유지한다.
4. T3는 화면/조작과 provider binding을 소유하고 실제 Pi session/runtime의 source of truth가 되지 않는다.
5. 실행 중 화면 연결이 끊겨도 작업을 유지한다. 저장 세션 목록 조회만으로 worker를 만들지 않는다.
6. canonical runtime은 아직 정하지 않는다. 두 완제품의 실제 계측과 사용감 비교 뒤에 결정한다.

## 완료 상태

- [x] CP1: 현재 저장소 조사와 `rubato-codex` 감사. 중복 session/runtime 없음 확인, manifest/낡은 시험 기대값 두 곳만 최소 수정.
- [x] CP2: 공식 Pi 채택표 작성, public Server/SessionRouter/Client/Chord 기반 session host/client 구현.
- [x] CP3: 기존 `rubato-pi --mode rpc`를 실제 worker launcher로 연결하고 저장/실행/attachment 수명주기와 재시작 경계를 구현.
- [x] CP4: 현재 T3 구조 조사, guarded overlay, 실제 `ProviderDriver`, project/thread inventory와 durable resume binding 구현.
- [x] CP5: 기존 idle/live session, 중복 worker 방지, prompt/steer/abort, text/reasoning/tool, 질문/확인, reconnect, 외부 상태 반영 통합시험 구현.
- [x] CP6: Codex/Pi/T3 자동 검사, 전체 T3 server 형 검사/번들 빌드, Pi lifecycle 계측 경로, 최종 문서와 인수인계 작성.
- [ ] PR merge 전 마지막 단계: PR의 `pull_request` merge ref에서 현재 `rubato/base`와 합쳐진 전체 자동 검사를 통과시킨다.
- [ ] 로컬 실제 제품 검증: macOS Codex Desktop, 실제 T3 Desktop/Web 조작, 실제 외부 모델 인증/유료 호출, 실제 첫 이벤트/첫 토큰 성능 비교.

## 최종 브랜치 자동 검사 기준

- Codex audit: 37개 중 36 통과, 실패 0, 건너뜀 1. 건너뜀은 실제 Codex 바이너리를 요구한다.
- Pi server: 10개 중 9 통과, 실패 0, 건너뜀 1. 건너뜀은 별도 실제 Rubato build candidate 환경 변수를 요구한다.
- T3 integration: 7개 모두 통과.
- T3 전체 server 형 검사: 통과.
- T3 전체 server bundle 빌드: 통과.
- Pi synthetic lifecycle 계측: 저장 세션 100개 조회 뒤 runtime 0개, warm attach 동일 runtime 유지 확인.

자동 검사는 실제 공식 Pi server/client/Unix transport, T3 contracts/Effect/decider/projector/provider factory와 실제 파일시스템을 쓴다. 모델 응답이 필요한 부분은 결정적인 시험 child를 사용하므로 실제 계정/유료 모델 성공으로 확대하지 않는다.
