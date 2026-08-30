# 설계와 리뷰 패턴

## 설계 독트린

방향을 가르는 분기와 진짜 불확실성에 mate를 쓴다.

### 블라인드 설계 (앵커 없는 입력)

먼저 스스로 분석하고, 그 분석은 brief에 넣지 않는다. 문제, 제약, 관련 파일, 중립적인 옵션 라벨만 보낸다. 동의가 아니라 가장 근거 있는 설계와 그것에 대한 가장 강한 반론을 요구한다.

```bash
meight dispatch design-auth --mode mate --cwd <repo root> --brief-file - <<'EOF'
We need to choose an auth-token refresh design.

Constraints:
- No user-visible logout regression.
- Existing token storage is in src/auth/store.ts.
- Existing request retry code is in src/api/client.ts.

Options:
- Option A: refresh before each protected request when expiry is near.
- Option B: centralize refresh in the API client on 401.

Give the best-supported design, the strongest case against it, and the evidence
that would settle remaining uncertainty. No code changes.
EOF
```

### 앵커드 설계 (방향이 정해진 경우)

```bash
meight dispatch design-refine --mode mate --cwd <repo root> \
  --brief "Direction is Option B. Pressure-test it: what am I missing, and what edge cases should the implementation cover?"
```

### 이견 처리

1. 두 설계를 비교한다.
2. 이견을 증거 문제와 가치 판단으로 가른다.
3. 증거 문제는 타겟 검증 세션 하나로 정리한다.
4. 사용자 소유 가치 판단(스코프, UX, 우선순위, 리스크 감내, 비가역 액션, 수용 기준)은 사람에게 올린다.
5. 더 논쟁해도 결정이 안 바뀌는 지점에서 멈춘다 — 되돌릴 수 있고 리스크 낮은 쪽을 택하거나 사용자 판단으로 올린다.

mate 대 mate 논쟁 루프는 돌리지 않는다. 두 설계가 다 나오기 전에 한쪽을 다른 쪽에 먹이지 않는다.

## 플랜 리뷰

verdict가 아직 방향을 바꾸거나 실패 비용을 실질적으로 줄일 수 있을 때 값을 한다. 구현의 선행 조건은 아니다. 쓸지 말지는 디스패처가 정하고 그 선택을 한 줄로 기록한다. 새 증거가 결정을 계속 바꾸는 동안에는 `reply`로 리뷰 스레드를 살려둘 수 있다.

기본은 일반 텍스트 결과다. 리뷰어는 `APPROVE`나 `REVISE`로 시작하고, `REVISE`는 필요한 경우 디스패처를 향한 `QUESTION:`으로 끝낸다. verdict가 걸리면 `--effort high`를 고려한다. 새 phase·방법·비용 범위·캡 연장은 사용자 소유다.

리뷰어는 네이밍/스타일 취향, 불가능한 엣지 케이스, 스코프 밖 가정, 현재 플랜이나 증거로 이미 해소된 발견을 억제한다. 디스패처가 승인된 버전 `PLAN.md`를 동결하면 스코프 변경이 그 결정을 다시 연다.

## mate 리뷰

브리프에는 정확한 리뷰 표면, 의도한 결과, 관련 제약, 이번 리뷰가 도울 결정을 담는다. 무엇을 관찰하고 어떤 비중으로 보고할지는 mate의 독립 판단에 맡긴다. 요청에 없더라도 결과나 결정을 materially 바꾸는 내용은 근거와 함께 올린다.

기본은 독립 mate 하나다. 다른 fresh read가 실제 결정을 바꿀 수 있을 때만 같은 중립 브리프로 mate 하나를 더 병렬 실행한다. 두 mate에게 서로의 결론이나 디스패처의 선호를 주지 않고, 디스패처가 압축 결과를 중재한다. worker의 자기 리뷰와 외부 mate 리뷰는 서로 다른 증거원이다.

```bash
meight dispatch review-X --mode mate --cwd <repo root> --brief-file - <<'EOF'
Review target: <exact files, commit, diff, or plan version>.
Intended outcome and constraints: <contract>.
Use independent judgment. Report anything material to the outcome or decision,
including useful observations not asked for. Support claims with evidence.
<Add a formal verdict only if the decision needs one.>
EOF
```

형식적 수용 verdict나 실패 비용이 `high`를 정당화할 때만 `--effort high`를 더한다. 두 번째 독립 read를 쓸 때는 위 명령과 같은 브리프를 다른 이름으로 동시에 실행한다. 충돌이 실제 결정을 바꿀 때만 해당 mate에 표적 follow-up을 보낸다.

모든 리뷰 verdict는 리뷰한 정확한 입력을 지목한다 — 플랜 리뷰면 `PLAN.md` 버전, 코드 리뷰면 커밋 해시/디프 정체성. verdict에 따라 움직이기 전에 그 정체성을 현재 아티팩트와 비교하고, 안 맞으면 stale로 버린다.

발견을 중재하는 건 디스패처다. `NO-GO`는 블로커가 나왔다는 뜻이다. 현재 사용자 승인 phase가 bounded 수리 1라운드를 명시적으로 포함하면 유효한 블로커를 구현자에게 넘기고, 수정을 검증하고, 새 리뷰 정체성에 대해 verdict 하나를 받는다. 아니면 멈추고 사용자에게 묻는다. 두 번째 NO-GO나 재리뷰 후 새 블로커는 campaign을 끝낸다 — 이걸 리셋하려고 워커나 리뷰 정체성을 새로 만들지 않는다. acceptance gate로 선택한 리뷰만 verdict + 검증 증거를 sign-off에 요구하고, advisory 리뷰는 판단 입력으로 쓴다. 디프 전체를 읽는 건 sign-off 게이트가 아니다. 동결된 플랜의 스코프·방법·비용 범위·수용 경로를 바꾸는 변경은 그 결정을 다시 연다.

리뷰의 severity 임계값과 스코프는 그 brief에서 정한다. 상세 로그가 decision 리포트를 과적재할 것 같으면 `<worker-name>-evidence.md`에 넣는다.

### frozen-plan 구현 리포트 매핑

승인된 플랜 아래 도는 worker의 구현 리포트는 플랜 근거를 기존 decision 스키마에 얹는다:

- `summary`: 플랜 버전을 명시하고 모든 편차와 그 근거를 적는다.
- `verification`: 구현이 동결된 플랜을 충족한다는 증거.
- `risks`: 의도적으로 하지 않은 것과 그 이유 (기록할 게 정말 없을 때만 빈 리스트).
- `changed_files`, `commits`: 리뷰 표면을 정확히 식별.

## Fresh-Eyes UI 리뷰 (프론트엔드 디스패치)

프론트엔드 워커가 `IMPLEMENTED, FRESH-EYES PENDING`을 보고하면, `VERIFIED`를 받기 전에 독립적인 이해도 리뷰어를 디스패치한다. 프로토콜과 리뷰어 프롬프트 원문: `~/.codex/skills/frontend-ux-router/references/fresh-eyes-review.md`.

- 원샷 `--mode worker` (verdict 리뷰가 아니라 comprehension check). 주는 것은 페르소나 라인, 스크린샷 경로(또는 라우트), 리뷰어 프롬프트뿐이다. 구현 컨텍스트 0 — brief도, 디프도, 설명도 없다. 오염되면 리뷰가 무효다.
- FAIL이면 리뷰어의 raw 답변을 구현자에게 재설계 입력으로 돌린다(카피 패치가 아니라 path-card 재구성). fresh-eyes 한 번 더가 결정을 바꿀 수 있는지는 디스패처가 판단한다.
