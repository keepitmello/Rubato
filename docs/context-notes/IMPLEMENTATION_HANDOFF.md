# 루바토 작업 노트 문맥 관리 두 번째 버전 인수인계

작성일은 2026-09-06이에요. 첫 전달 파일을 검토해 캐시 안내, 노트 최신성, 전환 직전 경합, 저장 후 실패 처리와 기록 검색을 수정했어요. 로컬 비용 합산·조건부 시뮬레이션 도구와 후속 행동검증 전략도 포함했어요.

독립 테스트 104개를 실행해 통과했어요. 실제 루바토 설치본의 전체 빌드·형 검사·전체 테스트, 실제 AgentSession과 모델, 터미널·원격 화면 검증은 아직 남아 있어요. 화면 관련 개발 상태는 `IMPLEMENTED, RENDER VERIFICATION PENDING`이에요. 막힌 이유는 이 환경에 고정 엔진과 의존성, 실제 실행 화면이 없기 때문이에요.

기준 저장소는 `keepitmello/Rubato`, 브랜치는 `rubato/base`, 커밋은 `98958616cda4e7a34aa2033f6d29028fea4d4219`예요. 현재 루바토의 기준 엔진은 `@code-yeongyu/senpi@2026.9.4-3`예요. GitHub에는 변경을 쓰지 않았어요.

## 1. 작업 목적

같은 세션의 원문을 보존하면서 현재 모델이 작업 노트를 쓰고, 요약 없이 활성 문맥을 새 창으로 바꾼 뒤 필요한 원문만 읽도록 해요. 기존 구현의 결함을 보완하고, 모델을 반복 호출하기 전에 로컬 기록으로 비용 후보를 줄일 수 있게 했어요.

이 파일 묶음은 이전 ZIP을 대체하는 전체 패치 묶음이에요. 이전 ZIP을 먼저 적용할 필요는 없어요. 전체 저장소는 아니므로 현재 저장소에 추가·수정 파일을 합쳐야 해요.

## 2. 확정된 설계

아래 결정은 로컬 검증 중에도 임의로 바꾸지 않아요.

1. `history-notes`에서 별도 모델 요약, 서버 요약, 긴급 대화 삭제로 자동 전환하지 않아요. 실패하면 원문을 보존하고 중단해요. 비교 모드 `summary`는 별도 실행으로 선택해요.
2. 현재 모델이 직접 노트를 써요. 전환 함수 자체는 모델을 호출하지 않지만 노트 작성·확인·재읽기의 모델 비용은 존재해요.
3. 기존 SessionManager가 원문 세션 파일의 유일한 작성자예요. 노트 판본과 창 경계도 그 파일에 추가해요. SQLite는 다시 만들 수 있는 색인과 진단 저장소예요.
4. 세션 식별자와 작업 환경은 유지해요. 새 세션을 만들어 연결하는 우회 방식으로 바꾸지 않아요.
5. 새 창에는 창 식별자와 작은 노트 목록을 넣어요. 노트 본문과 이전 원문 전체를 자동으로 넣지 않아요. 창 안에서 이미 보낸 안내·기준 메시지는 다시 쓰지 않아요.
6. 노트 뒤 일반 작업이나 입력이 추가되면 그 노트로 전환하지 않아요. 실제 경계를 저장하기 직전에도 현재 가지 끝과 취소 상태를 확인해요.
7. 경계 저장 뒤 후처리 실패는 성공이 아니에요. 현재 실행의 다음 요청을 차단하고 같은 세션을 다시 열어 복구해요. 같은 경계를 중복 생성하지 않아요.
8. 현재 세션의 현재 가지 안에서만 검색해요. 되돌린 미래 가지나 다른 팀원 세션의 기억을 자동으로 공유하지 않아요.
9. 필수 엔진 연결이 어긋나면 실패해요. 꾸밈용 변환처럼 오류를 삼키고 기존 요약을 실행하지 않아요. 실행 중 모드·코드 교체는 지원하지 않아요.
10. 비용은 관측 사용량 합산과 조건부 재생을 분리해요. 시뮬레이션의 가정값을 실제 모델의 원문 읽기량·최적 임계점으로 발표하지 않아요.

원래 전달 파일의 기본 `history-notes` 선택을 유지했어요. 페이블 서버 압축 65%나 아스트라 물리적 창 272K는 이번 수정에서 변경하지 않았어요. 가격 비교 후보는 시뮬레이션 설정에만 넣었어요.

## 3. 변경 파일

정확한 전체 목록, 파일 크기·SHA-256, 기존 Git 원본 해시와 이전 전달 파일 해시는 `PATCH_MANIFEST.json`에 있어요. 매니페스트 자체는 자기 해시 목록에서 제외해요.

기존 저장소 파일 네 개를 수정해요.

| 파일 | 역할 |
|---|---|
| `harness/rubato-pi/package.json` | 기존 테스트를 비교 모드로 실행하고 새 문맥·비용 테스트와 설치본 검사 명령을 등록해요. 의존성은 추가하지 않아요. |
| `harness/rubato-pi/src/extensions/adapter.mjs` | 역할 지침 뒤 새 확장을 연결하고, 새 모드에서 서버 요약 확장을 설치하지 않아요. |
| `harness/rubato-pi/src/no-changelog-hooks.mjs` | 기존 변환 뒤 필수 문맥 변환을 실행해요. 필수 변환 오류는 숨기지 않아요. |
| `harness/rubato-pi/src/anthropic-server-compaction.mjs` | 새 모드에서 서버 요약 지원 판별을 끄고 기존 모드는 유지해요. |

추가 파일의 역할은 아래와 같아요. 다음 코드 경로는 `harness/rubato-pi/` 아래예요.

| 파일 또는 묶음 | 역할 |
|---|---|
| `src/context-notes/config.mjs`, `protocol.mjs` | 모드·예산·창 식별자·경계·가상 경로 계약이에요. |
| `src/context-notes/history-source.mjs`, `journal.mjs` | 전체 원문의 부모 연결을 복원하고 기존 작성자의 저장을 확인·동기화해요. |
| `src/context-notes/store.mjs` | 원문·노트 색인, 현재 가지 접근 범위, 검색·읽기·이어보기와 진단이에요. |
| `src/context-notes/reminder.mjs` | 창당 한 번 기록하는 고정 안내와 안정적인 삽입 위치를 관리해요. |
| `src/context-notes/checkpoint.mjs` | 노트 뒤 새 작업이 있었는지 검사해요. 의미 품질을 평가하는 모델은 추가하지 않아요. |
| `src/context-notes/controller.mjs`, `engine-gate.mjs` | 노트 저장, 전환 예약·적용·격리, 마지막 저장 직전 검사를 연결해요. |
| `src/context-notes/tools.mjs`, `src/extensions/context-notes.mjs` | 도구 11개와 명령·이벤트를 연결해요. |
| `src/transforms/core-context-notes.mjs` | 실제 고정 엔진의 요약·입력·경계 저장 위치에 필수 검사를 붙여요. |
| `scripts/check-history-notes-engine.mjs` | 설치본 버전·연결 위치 일곱 곳과 변환 후 구문을 검사해요. |
| `scripts/verify-context-notes-package.mjs` | 전달 파일 해시와 로컬 원본·이전 버전·수정분을 읽기 전용으로 비교해요. |
| `scripts/context-notes-report.mjs` | 원문 없이 도구·전환 진단을 요약해요. |
| `scripts/context-cost-audit.mjs` | 한 모델의 현재 가지 사용량을 합산하고 추정 재생 자료를 내보내요. |
| `scripts/context-cost-simulate.mjs`, `scripts/lib/context-cost-model.mjs` | 고정 작업량에서 임계점·기억 비용을 바꾸는 오프라인 계산이에요. |
| `scripts/run-unit-tests.mjs` | 기존 단위 테스트를 명시적 비교 모드로 실행해요. |
| `test/helpers/context-notes-fake.mjs` | 시험용 실행 절차예요. 실제 엔진으로 취급하지 않아요. |
| `test/unit/context-notes-*.test.mjs` | 저장·전환·캐시 앞부분 유지·경합·오류·검색·적용 전 검사·변환 실행을 검사해요. |
| `test/unit/context-cost-model.test.mjs` | 사용량 중복 과금, 캐시 쓰기, 할증 경계, 고정 작업 재생과 가정 검사를 해요. |
| `test/integration/context-notes-engine.test.mjs` | 실제 설치된 SessionManager 저장·문맥 구성·재열기를 검사해요. 전체 AgentSession 검사는 아니에요. |

문서는 `docs/context-notes.md`, `context-notes-review.md`, `context-notes-validation.md`, `context-cost-simulation-guide.md`, `context-cost-local-measurement.md`, `context-notes-behavior-guide.md`예요. 가격·아스트라·페이블 시나리오 JSON과 시험용 합성 기록도 `docs/`에 있어요. 2026-09-06 16:10 KST 로컬 실측은 `docs/context-cost-local-measurement.md`예요.

## 4. 구현 내용

이전의 일시적 잔여 토큰 안내를 제거했어요. 안내 문구와 기준 위치를 세션에 저장하고 이후 요청·재시작에서도 같은 위치로 복원해요. 원본 대화는 변경하지 않아요. 노트 목록 안내도 창 안에서 바뀌지 않아요.

전환은 최신 사용자 요청뿐 아니라 노트 뒤 도착한 실제 작업 결과도 확인해요. 엔진의 비동기 검사 뒤 최종 저장 직전에 한 번 더 검사하도록 연결했어요. 경계가 파일에 저장됐지만 후처리가 실패한 경우 실행을 격리해요.

기록 식별자·창 연결·같은 노트 판본 변경을 검사하고, 파일 목록·검색의 크기 제한과 이어보기를 보완했어요. SQLite 디렉터리·파일·보조 파일 권한을 제한했어요. 이전 변환 위에 새 변환을 겹치는 설치는 거부해요.

가격 비교는 실측 기록 합산과 가상 재생을 별도 출력으로 만들었어요. 앤트로픽 내부 압축 비용을 중복으로 더하지 않고, 새 방식의 노트 작성 전후 왕복과 노트·원문 재읽기를 비용에 넣었어요. 실제 조회량이 없으면 시나리오별 조건부 결과만 만들어요.

## 5. 아직 실행하지 못한 검증

이 환경은 Node 22.16.0이며, 저장소가 요구하는 Node 24·Bun·고정 엔진 전체와 의존성이 없어요. GitHub 연결로 실제 소스를 확인했지만 컨테이너에서 공개 저장소를 내려받으려던 네트워크 요청은 DNS 오류로 실패했어요. 독립 코드의 시험 결과를 전체 설치 성공으로 해석하면 안 돼요.

- Node 24 이상에서 전체 설치·빌드·형 검사·기존 전체 테스트
- 실제 배포 엔진 `2026.9.4-3`에 대한 필수 변환과 SessionManager 통합 검사
- 실제 AgentSession의 도구 묶음 끝 전환과 공급자 직전 최종 입력
- 대상 모델의 노트 내용, 원문 복구, 캐시 사용량과 실제 비용
- 장기 도구·대기 입력·이미지·팀원·원격 접속과 터미널 화면
- macOS·Windows 파일 동기화와 권한·링크 처리

센피 참고 소스는 `4df67dc87a21ccbc1c5b2de9e4cd69af295fec02`예요. 이것이 npm 배포본과 완전히 같은 내용이라고 단정하지 않아요. 검사 도구가 설치본의 실제 연결 위치를 검사해요.

## 6. 로컬 검증 절차

### 적용 전 확인

실행 중인 루바토를 종료하고 현재 변경과 세션 자료를 보관해요. `git status --short`, `git rev-parse HEAD`를 확인하고 별도 실험 브랜치나 작업 사본에서 적용해요. 사용자 작업을 강제로 초기화하지 않아요.

압축을 저장소 밖에 풀고 다음 읽기 전용 검사를 해요.

```sh
node /압축을/푼/위치/harness/rubato-pi/scripts/verify-context-notes-package.mjs /실제/Rubato
```

`can-update-original`은 기준 원본, `can-upgrade-v1`은 첫 ZIP과 같은 파일, `already-current`는 이번 파일과 같은 상태예요. `can-add`는 새 파일이에요. `merge-required`나 `missing-original`이면 그대로 덮어쓰지 말고 비교 후 합쳐요. 종료 코드 2는 수동 병합이 필요하다는 뜻이에요. 검사기는 어떤 파일도 적용하거나 지우지 않아요.

### 설치·자동 검사

상대 경로를 유지해서 파일을 합친 뒤 저장소 루트에서 실행해요.

```sh
node --version
bun --version
bun install --frozen-lockfile
npm run build
npm --prefix harness/rubato-pi run check:context-notes-engine
npm --prefix harness/rubato-pi run test:context-notes
npm --prefix harness/rubato-pi run test:context-cost
RUBATO_CONTEXT_MODE=summary npm --prefix harness/rubato-pi run test:context-notes
npm run typecheck
RUBATO_CONTEXT_MODE=summary npm test
RUBATO_TEST_CONTEXT_NOTES_ENGINE=1 \
  node --test harness/rubato-pi/test/integration/context-notes-engine.test.mjs
```

기존 테스트는 비교 모드에서 기존 동작이 유지되는지 검사해요. 새 모드 실제 실행은 위 통합 검사와 행동검증 문서를 따로 따라가야 해요. 건너뛴 검사를 성공으로 적지 않아요.

### 모델 없는 비용 계산

사용 절차는 `docs/context-cost-simulation-guide.md`에 있어요. 명령이 작동하는지만 먼저 확인하려면 아래 합성 기록을 사용해요. 출력 파일은 덮어쓰지 않으므로 새 이름을 사용해요.

```sh
node harness/rubato-pi/scripts/context-cost-simulate.mjs \
  docs/context-cost-example-trace.json docs/context-cost-astra-scenarios.json /tmp/astra-cost-example.json
node harness/rubato-pi/scripts/context-cost-simulate.mjs \
  docs/context-cost-example-trace.json docs/context-cost-fable-scenarios.json /tmp/fable-cost-example.json
```

실제 판단은 기존 로컬 세션에서 내보낸 자료를 보정해 계산해요. 합성 기록의 최저가나 이전 대화의 임계점 숫자는 운영 권고가 아니에요. 2026-09-06 16:10 KST에 로컬 세션을 다시 센 결과는 `docs/context-cost-local-measurement.md`예요. 기본 설정에서는 노트와 기존 압축이 또이또이했고, 노트 원문 재읽기량은 아직 없어요.

### 실제 경로 검증

`docs/context-notes-behavior-guide.md` 순서대로 실제 AgentSession과 시험용 응답 검사를 추가한 뒤 작은 모델 과제, 최종 대상 모델 후보를 확인해요. 공급자에게 실제 보내는 입력을 확인해야 해요. 내부 이벤트 이름이나 시험용 객체만으로 완료 처리하지 않아요.

## 7. 성공 조건

필수 엔진 변환 일곱 곳이 모두 적용되고, 전체 저장소의 빌드·형 검사·기존 테스트와 새 테스트가 통과해야 해요. 기존부터 실패하는 검사는 이번 변경과 분리해 재현 자료를 남겨요.

실제 같은 작업에서 요약 없는 창 전환을 여러 번 마치고 노트·원문을 읽어 처음 요구사항을 지켜야 해요. 재시작·경합·취소·저장 실패에 원문을 잃거나 실패를 성공으로 표시하면 안 돼요. 새 창 첫 입력에 이전 전체 기록을 몰래 다시 넣어도 실패예요.

비용 도구는 기록된 사용량을 중복 없이 합산하고, 같은 작업량의 후보를 비교해야 해요. 미계상 사용량과 추정값을 남겨야 해요. 비용 우위는 보정한 가정 범위와 실제 성공한 작업이 뒷받침할 때만 판단해요.

터미널과 원격 화면에서 시작·남은 문맥·전환·오류·다시 열기 안내를 직접 확인한 뒤 화면 검증을 완료로 바꿔요.

## 8. 주의할 부분

기본이 노트 모드이므로 실제 업무 중인 공유 환경에 즉시 적용하지 않아요. 기존 세션으로 비교하려면 명시적인 `summary` 실행을 사용하고, 이미 노트 경계가 있는 기록은 노트 모드로 다시 열어요.

전환의 내부 경계 필드는 기존 엔진의 `compaction` 이름을 사용해요. 생성 요약인지 창 안내인지는 내용과 호출을 확인해야 해요. 다른 확장이나 중계 실행기가 자체 요약을 실행한다면 같은 실험으로 처리하지 않아요.

토큰 예비 계산은 근사예요. 전체 기록 복원 시간과 이미지 입력 크기도 실제 장기 세션에서 확인해야 해요. 원문과 노트에 민감한 코드·대화가 들어갈 수 있어요. 외부에 공유할 때는 본문이 없는 진단을 우선 사용해요.

비용 합산기는 한 모델·한 가지의 센피 정규화 사용량을 지원해요. 원시 응답 형식, 다른 모델 별칭, 기록되지 않은 재시도는 자동 추정하지 않아요. 구독 사용량을 API 가격으로 환산한 값과 실제 구독 청구·한도는 구별해요.

## 9. 로컬 에이전트의 수정 권한

단순 구현 오류, 형 오류, 이름·경로 차이, 같은 의미의 엔진 연결 위치 차이, 사소한 통합 문제와 테스트 실패는 위 확정 설계를 유지하는 범위에서 직접 수정하고 재검증해도 돼요. 실제 사용량 자료에 맞춘 비용 정규화와 추가 시나리오·관측 항목도 기존 사실을 왜곡하지 않는 범위에서 보완할 수 있어요.

핵심 설계 결정, 구성요소의 책임, 데이터 구조·흐름, 통신·외부 연동 방식을 바꿔야 한다면 임의로 선택하지 않아요. 선택한 기술이 핵심 요구사항을 만족하지 못하거나 실제 실행이 중요한 전제를 반박해도 마찬가지예요. 코드에 맞추려고 엔진 버전을 바꾸거나, 새 세션·별도 요약으로 몰래 우회하지 않아요.

그 경우 해당 변경을 멈추고 `DESIGN_REVIEW_REQUEST.md`를 작성해요. 문제 위치, 재현 방법, 기대 결과, 실제 결과, 기존 설계가 실패하는 이유, 영향 범위, 현재 가능한 대안, 다시 필요한 설계 판단을 담아요. 인증 정보를 제거한 로그·실행 버전·실패 입력도 함께 보관해요. 사용자가 이 자료를 이 대화에 전달하면 문제가 드러난 범위만 설계 검토로 되돌릴 수 있어요.
