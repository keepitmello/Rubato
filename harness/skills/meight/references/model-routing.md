# 모델·effort 라우팅 근거

SKILL.md의 기본값 표가 왜 그 자리에 있는지. 기본값만 쓸 거면 이 파일은 필요 없다.

## 사다리와 비용

Artificial Analysis Coding Agent Index v1.3 (종합 / DeepSWE / SWE-Atlas-QnA / 태스크당 비용):

- `luna xhigh` 55 / 57 / 31 / $0.25
- `luna max` **59 / 63 / 33 / $0.31**
- `sol medium` 61 / 64 / 40 / **$2.99**

luna 비용은 2026-08-08 가격 개정(-80%)을 반영한 값이고, 점수는 원본 벤치 그대로다. terra도 같은 개정에서 -20%.

모델 선택은 두 축으로 읽는다. 첫 축은 **브리프 완결성**이다. 작업 전체의 계약
(수용 기준)·범위(파일/디렉토리 경계)·증거(검증 방법)가 브리프에 완결적으로
들어 있으면 디스패처가 `--model luna`를 명시 선택할 수 있다. CLI는 이 선택에서
`luna max`와 Fast를 함께 해소한다. `luna max`는 실행·수렴에 강하고 태스크당
비용이 `sol medium`의 1/9.5이며, 완결된 실행 계약에서 비용 대비 값이 난다.

기본 worker는 `sol medium`이다 (2026-08-21 개정).
`sol medium`은 종합 점수 61, DeepSWE 64뿐 아니라 레포 이해·탐색에 해당하는
SWE-Atlas-QnA에서 **40 대 33**으로 `luna max`를 앞선다. 완결 브리프에서
실행 수렴을 고르면 `--model luna`다. mate/review 기본도 `sol medium`이다.

xAI 는 이 하네스를 떠났다 (2026-08-21). grok 은 rubato 가 xAI OAuth 로
직접 잡고(`rubato dispatch --model xai/grok-4.6`), meight 는 Codex 세션
전용이다.

전문: [`docs/2026-07-29-model-routing-evidence.md`](../../../docs/2026-07-29-model-routing-evidence.md)

## 난이도가 올라갈 때

난이도는 worker 브레인을 바로 키우는 대신 **단계 추가**로 답한다: `sol` mate에게
설계·플랜을 받아 동결하고, 수용 기준·파일/디렉토리 범위·검증 방법이 채워진
브리프로 넘겨 worker가 기본 `sol medium`으로 구현한다. 실행 수렴이 따로 필요하면
`--model luna`를 명시한다. 판단이 어려운 것과 실행이 어려운 것은 다른 문제고,
대부분의 어려움은 앞쪽에 있다.

worker의 `sol`은 **항상 `medium`**이다. 형식적이거나 실패 비용이 큰 리뷰는 `sol high`를 쓸 수 있다.
설계의 `high`/`xhigh`는 정말 어려울 때만 사용자 확인 후 쓴다. `sol`의 effort 상한은
`high`다.

## 승급 판단 축

브리프 완결성과 별개로 **실패 비용**을 판단한다. 돈·데이터 손상, 비가역,
프로덕션 확산이면 필요한 브레인 승급이나 리뷰·사인오프 게이트를 적용한다.
동시성이든 마이그레이션이든 계약 설계든 경계와 검증 방법이 분명하면 작업의
이름만으로 모델을 올리지 않는다. 올렸으면 무엇을 보고 올렸는지 한 줄로
남긴다. 돈 경로의 디스패처 sign-off와 worker의 작업 전 에스컬레이션 게이트는
모델 선택과 독립된 소유권·안전 축으로 유지한다.

## 측정에서 나온 주의점

`medium`은 적대적 리뷰에서 severity를 과대 승격하는 경향을 보였다. 형식적
verdict가 중요한 리뷰는 `sol high`를 고려하고, 그 밖의 mate는 기본
`sol medium`에서 시작한다.

## terra

기본 소유 영역 없음. capability-specific 이유와 측정 근거가 있을 때 `luna`
또는 `sol`에서의 에스컬레이션을 받을 수 있다. baseline 전에는 승급 규칙을
가정하지 않는다.
