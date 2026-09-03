# 소유권, 승인, 에스컬레이션, 학습 루프

## 소유권 경계

- 사용자가 소유: WHAT, WHY, 우선순위, 스코프, UX, 사용자 눈에 보이는 동작, 리스크 감내 범위, 수용 기준, 새 phase 진입 승인.
- 디스패처가 소유: 위 결정의 보존, 현재 승인된 phase 안의 기술 선택, 사용자 커뮤니케이션, 통합, 검증, git 조율. 사용자 대신 확장된 작업을 승인하지는 않는다.
- Codex worker가 소유: 기술 설계, 구현, 검증, 자기 리뷰, 로컬 실행 선택. 별도 외부 리뷰 세션을 띄울지는 디스패처가 소유한다.
- mate가 소유: 플랜·방향·코드·독트린에 대한 독립적 반론과 verdict.

mate / worker는 모델이 아니라 세션 계약(자세)의 이름이다 — `--mode`가 계약을 고르고 `--model`이 두뇌를 고른다. 둘 다 침묵 실행자가 아니라 팀원 계약이라, 더 나은 방향·잘못된 전제·자기 소유 밖 결정이 보이면 구조화된 `QUESTION:`(`KIND: better-direction`)으로 밀어내고, 막히지 않는 관찰은 `risks[]`에 남긴다.

검증이 결과를 소유한다. 워커의 "done"은 주장이고, 관련 테스트나 런타임 확인 + 디스패처 sign-off가 그걸 사실로 만든다. acceptance gate로 선택한 리뷰는 verdict + 검증 증거로 sign-off하고, advisory 리뷰는 verdict 의무 없이 판단 입력으로 쓴다. 디스패처는 자기 게이트 선택을 한 줄로 기록한다. 기본 전달 체인 같은 건 없다.

세션은 brief가 허용하면 완료·검증된 작업을 commit/push할 수 있지만, 최종 통합과 승인은 여전히 디스패처 몫이다.

## Phase 승인과 campaign identity

사용자 승인은 명명된 phase, 방법, 예상 비용 범위, 수용 경로에 묶인다. 필요한 게이트가 실패하거나, 다음 액션이 방법·예상 비용을 실질적으로 바꾸거나, 작업이 결과 진전에서 기록 보강으로 옮겨가면 만료된다.

시도·수리 라운드·리뷰 라운드는 추구 중인 사용자 결과와 결정 기준으로 센다. campaign identity는 워커 이름 변경, 새 스레드, 플랜/부록 개정, 브랜치, 아티팩트·리뷰 정체성 변경을 넘어 살아남는다. 새 세션을 시작해도 캡은 리셋되지 않는다.

승인된 한 phase 안에서 bounded 수리 1회와 재리뷰 1회까지 선승인될 수 있다. 두 번째 NO-GO, 재리뷰 후 새 블로커, 승인된 phase 밖으로의 재라우팅은 자동 진행을 멈춘다. 디스패처는 가장 싸게 믿을 만한 실패 기록을 모을 수 있고, 그다음에는 구현이나 리뷰를 더 디스패치하기 전에 실패·선택지·권고를 사용자에게 돌려준다.

## 구조화된 QUESTION 라우팅

정확한 text/decision 모드 질문 포맷은 [공통 계약](../../meight-common/CONTRACT.md)에 있다. 디스패처를 향한 기술적·정보 부족 질문은 `reply`로 답하고, 사용자 소유인 스코프·UX·우선순위·리스크·비가역·수용 결정은 사람에게 간다.

질문은 워커가 붙인 라벨이 아니라 **답했을 때의 효과**로 분류한다. 답이 새 워커, 새 phase, 플랜/부록, 선승인된 재리뷰를 넘는 리뷰 정체성, 비싼 재실행, 실질적으로 다른 방법, campaign 캡 이후 추가 수리를 승인하는 것이라면 그건 사용자 소유의 스코프·우선순위·수용 결정이다. `TARGET: dispatcher`나 `KIND: technical`이라고 선언돼 있어도 `meight reply`로 답하지 않는다.

데몬 파싱은 관대하다. `TARGET`이 없으면 `dispatcher`가 기본. 파싱된 값은 `status.json`에 `needs_input_target`, `needs_input_kind`로 기록된다. exit code는 바뀌지 않는다 — 최종 구조화 질문은 여전히 `3`으로 종료. 중간 레이어가 분류한다: `TARGET: user`나 사용자 소유 kind는 사람에게 그대로 올리고, 나머지는 `meight reply`로 답한다.

```bash
meight reply <name> --brief "Use config-a.json and keep the legacy field."
```

올리기 전에 preference 원장을 본다 — 이미 답이 나온 부류의 질문은 다시 묻지 않고 원장에서 답한다.

같은 campaign 승인과 worker/repair 캡이 유효한 동안에만 이어간다. 아니면 후속 턴을 시작하기 전에 사용자에게 돌아간다.

## 학습 루프: 결정 기록, 선호, 교훈

하네스는 결정과 답이 에이전트가 실제로 읽는 곳에 쌓일 때만 좋아진다. 원장 셋, 전부 평문 파일이다.

### 결정 기록 (`<repo>/decisions/`)

보존할 가치가 있는 방향 설정 분기점은 작업 레포에 `decisions/YYYY-MM-DD-<slug>.md`로 쓴다:

```md
# <the question>
DATE: <date> · FORK: two-design
ANALYSIS A (dispatcher): <one-paragraph position>
DESIGN B (mate, blind|anchored): <one-paragraph position>
DISAGREEMENT: <where they split, or "none">
RESOLUTION: evidence|value-judgment — <what settled it>
DECISION: <what was chosen>
STATUS: adopted
```

two-design 분기의 durable output이다. 컨텍스트 압축을 넘어 살아남고, 나중 세션이 *왜*를 감사할 수 있게 하고, 다음 분기를 더 빨리 정리할 판단 패턴을 쌓는다. 삭제 대신 `STATUS: superseded by <file>`로 대체한다.

### 선호 원장 (`<daemon-home>/notes/preferences.md`)

`TARGET: user` 질문을 올리기 전에 원장을 본다. 같은 부류를 사용자가 이미 답했으면 다시 묻지 말고 기록된 선호를 인용해 `reply`로 답한다. 사용자가 새로 뭔가 정하면 한 줄 추가: 선호, 한 절짜리 근거, 날짜.

예외: `KIND: irreversible`과 `KIND: risk` 질문은 기록된 선호가 일치해도 사용자에게 재확인한다.

### 교훈 (`<daemon-home>/notes/lessons.md`)

meight 세션 운용에 대한 교훈 — 반복되는 리뷰 발견 부류, brief 작성 구멍, 하네스 간섭 패턴 — 을 한 줄씩. 교훈이 반복되면 brief 템플릿의 Constraints나 이 스킬로 승격한다. 레포별 코드 패턴은 여기가 아니라 그 레포 문서에 둔다.

이 운영 모델에서 실제 결과로부터 배우려면 이 정도 구조화 데이터는 남긴다: mode, 한 줄 게이트 선택, 재라우팅/에스컬레이션과 그 이유, sign-off 후 발견된 false approval. 측정이 의례가 되면 안 된다.

에스컬레이션 규칙을 바꾸기 전에는 baseline 근거를 본다.
