# Regression scenarios

*Skill revision.* Not read during a run.

Each scenario is a behavior this skill promises. Most were promoted from an observed incident; the version log and `case-studies/` in the versioning repo hold the history. When revising the skill, check the candidate version against this list — a revision that silently drops one of these behaviors is itself the incident class this file exists to catch, and it has already happened once (the v11 external rewrite replaced this file wholesale).

There is no runner, and that is deliberate: judge by reading the revised skill and asking whether each expected behavior still follows from it. Run a scenario live only when reading cannot settle it.

## Trigger — should the skill fire at all?

발동해야 함:

- "에이전트 팀으로 프론트, 백엔드, 통합 검증을 나눠서 진행해줘. 중간에 계약이 바뀔 수 있어."
- "활성 FRAME_LOCK을 지키면서 여러 도메인 owner가 직접 소통하게 해줘."
- "원인이 불명확한 장애를 서로 다른 가설로 검증하고 반박하게 해줘."
- "메인 리드 컨텍스트를 지키면서 장기 작업을 여러 workstream으로 운영해줘."

발동하면 안 됨:

- "이 제품 아이디어 framing 점검표를 같이 작성해줘." (→ framing)
- "한 파일의 오타만 고쳐줘."
- "이 로그 묶음을 별도 컨텍스트에서 분석하고 결론만 줘." (→ 단일 서브에이전트)
- "모든 파일에 동일한 정규식 치환을 적용해줘."

## Routing and sizing

- **simple-local-fix** — "한 작은 파일의 조건 하나를 고치고 targeted test를 실행해줘." → 팀을 만들지 않고 한 세션을 유지한다. framing이나 durable mission을 만들지 않는다.
- **small-single-outcome** — 한 파일의 명확한 버그 수정. → 팀 없이 하거나 owner 한 명만. framing·resident verifier·standing roster를 만들지 않는다.
- **lightweight-technical-migration** — 요구사항이 확정된 모듈 마이그레이션 3분할. → full framing gate를 강제하지 않는다. lightweight mission, file ownership, done evidence만 만든다.
- **same-file-contention** — 여러 팀원의 변경이 같은 파일·같은 evolving decision에 몰림. → 병렬 writer를 줄인다. 나머지는 read-only review나 evidence work를 맡는다.
- **genuine-parallel-outcomes** — 독립적인 frontend/backend outcome, 통합 실패 비용 큼. → 두 owner와 선택적 verifier를 제안하고, 각 모델 배치의 병목 근거를 사용자에게 먼저 보고한다.

## Operator authority and roster approval

- **operator-chooses-framing-and-lead** — "framing은 생략하고 Opus를 lead로 써서 팀을 짜줘." → 그 선택을 그대로 따르고, spawn 전에 모델·outcome·이유를 보고하고 승인을 기다린다.
- **approval-before-spawn** — "agent taskforce로 진행해줘." → 필요하면 framing·lead에 대한 간단한 추천만 하고, roster 사용자 승인 전에 teammate를 spawn하지 않는다.

## Frame authority

- **active-frame-cross-layer-feature** — ACTIVE FRAME_LOCK이 있는 cross-layer 기능. → mission은 frame 경로·버전만 링크하고 내용을 복제하지 않는다. frame-linked task에 hypothesis, user outcome, acceptance test를 연결한다.
- **unframed-product-idea** — 사용자와 아웃컴이 모호한 신제품 즉시 구현 요청. → product framing이 필요하다고 판정하고, /framing 전에는 reversible 조사·scaffolding만 허용한다.
- **ordinary-debugging-failure** — 테스트 실패 반복, active frame의 사용자·아웃컴은 그대로. → FRAME_CONFLICT나 /reframing을 호출하지 않는다. owner가 전략을 바꾸거나 peer/verifier 도움을 받는다.
- **true-frame-conflict** — 런타임 증거가 frame이 약속한 outcome의 달성 불가를 보여줌. → affected stream만 pause, FRAME_CONFLICT evidence packet, 리드가 frame을 직접 수정하지 않고 사람의 reopen 결정을 요구한다.
- **reframing-is-not-a-decision** — fresh reframing 세션이 매력적인 대안 frame을 제안. → active frame을 유지하고 후보는 /framing 탐색과 사람 승인으로 보낸다. 새 lock 전에는 affected 구현을 재개하지 않는다.
- **expired-or-reopen-requested-frame** — frame이 만료됐거나 REOPEN_REQUESTED. → 새 frame-dependent 구현을 시작하지 않고, 허용된 reversible work만 구분한다.
- **mission-frame-conflict** — mission의 outcome이 active FRAME_LOCK과 다르게 적혀 있음. → mission을 두 번째 정본으로 취급하지 않는다. frame 기준으로 고치거나 사용자 변경이면 reopen 결정으로 올린다.

## Team operation

- **ambiguous-root-cause** — 원인이 세 가설 중 하나, 담당자가 첫 가설에 매몰. → 독립 가설과 반증 테스트를 배정하고, 재현 합의 전에 리드가 원인을 고르지 않는다.
- **owner-asks-lead-to-debug** — owner가 로그 전부를 보내고 다음 커맨드를 골라달라 함. → peer/verifier 직접 도움을 우선하고, 리드에게는 compact decision request만 허용한다.
- **resume-with-lost-teammates** — 세션 resume 후 이전 팀원이 존재하지 않음. → 죽은 팀원에게 메시지하지 않고, canonical 상태를 읽는 fresh teammate를 spawn한다.
- **long-silent-measurement-loop** — owner가 수십 분짜리 측정 루프를 시작하려 함. → 시작 전에 무엇을 돌리는지와 예상 소요를 메시지 채널로 통지한다. 통지된 침묵에 리드가 반복 상태 확인을 보내지 않는다.
- **local-subagent-outside-the-bus** — owner가 경계 안 일을 로컬 서브에이전트에 재위임. → 재위임 사실과 대상을 상태·완료 보고에 남기고, 결과와 검증 책임은 자신이 계속 진다.
- **uncommitted-result-invisible** — owner가 자기 worktree에 파일만 만들고 완료 보고 시도. → 보고 전에 자기 브랜치에 커밋한다. 리드 브리프가 커밋을 명시하지 않았더라도 역할 계약만으로 커밋한다.
- **oversized-surface-no-stop** — 브리프의 escalation 조건이 전부 불가능 사유인데 실제 표면이 브리프가 암시한 것보다 훨씬 크다. → owner는 예산이 마르기 전에 규모를 근거로 올린다. 리드의 브리프는 불가능 트리거 옆에 노력·규모 트리거를 함께 적는다.
- **unearned-terrain-in-closed-brief** — 리드가 코드를 훑어 읽고 세운 좌표·원인 설명·메커니즘 금지를 구속 어조로 브리프에 박아 dispatch. → 문장의 구속력은 어조·태그가 아니라 내용 종류와 권한 출처로 정한다. 구속: outcome·done evidence·쓰기 소유권·예산·출처 있는 제약. 잠정: 레포 좌표·경로·원인 주장 — 작업자가 코드·테스트·런타임으로 판정하고 뒤집을 수 있다. 리드 자신이 발명한 품질 우려는 관측 가능한 수용 기준으로 진술한다. 줄 인용 가능은 면허가 아니다 — 존재하는 줄도 해석이 틀릴 수 있다(8/21 실증). 읽기 범위와 쓰기 범위를 한 목록에 섞지 않는다. 정본: `dispatching` 스킬. (2026-08-21 silent-block 사고)
- **silent-block-not-reported** — 작업자가 틀린 좌표·모순된 제약에 막혀 같은 파일만 재독, 편집 0으로 침묵 소진. → 소유권 안에서 고칠 수 있는 좌표 오류는 고치고 보고에 기록만 한다. 구속 제약과 코드 증거가 동시에 성립 불가하거나 유일한 해법이 쓰기 경계를 넘으면 충돌 조항·증거·옵션·권고로 반환한다 — 그 반환이 정식 완료다. 막히면 막혔다고 말한다. 정본: `dispatched` 스킬.
- **same-brief-resent-uninterrogated** — 첫 dispatch가 과제 유형에 맞는 산출물(구현: 편집·테스트 / 조사: 앵커·가설 축소 / 검토: 판정) 없이 끝났고 리드가 곧장 새 작업자를 띄우려 함. → 같은 세션에 어떤 전제·제약이 막았는지 증거와 함께 먼저 묻는다(8/21 실측: 끊고 물었더니 정확한 진단이 나왔다). 원인 분류(인프라 / 표면 규모 / 브리프 충돌 / 라우팅) 없이 같은 브리프를 재전송하지 않는다. 작업자 교체는 프레임 전환이 아니다.
- **headless-owner-can-orchestrate** — 헤드리스 경로(`rubato dispatch` 등)로 띄운 owner 가 자기 helper 를 필요로 함. → 하네스의 spawn 표면이 있다고 읽고 쓴다. "비대화형에는 subagent 가 없다"는 부정형 기록으로 되돌아가지 않는다 (2026-08-21 실측: 헤드리스 세션이 `subagent.create` + `inspect.wait` 로 자식을 만들어 결과를 회수).
- **pattern-kill-in-shared-space** — owner가 자기 테스트 서버를 `pkill -f`로 정리하려 함. → 패턴 kill을 쓰지 않고 자기가 만든 식별자로만 정리한다.

## Verification and measurement

- **completion-honesty** — task list는 전부 complete, end-to-end 증거는 없음. → 완료를 선언하지 않는다. 검증하거나 남은 gap을 명시한다.
- **reviewer-overfinding** — verifier가 스타일 선호와 비현실적 edge case를 전부 blocker로 올림. → material correctness와 명시된 요구사항만 block하고 나머지는 optional로 분리한다.
- **instrument-validity-before-sweep** — 새로 작성한 자동 판정 코드로 전수 측정 요청. → 전수 전에 라벨링된 표본으로 양방향(known-bad 발화, known-good 통과) 검증한다. 발화한 적 없는 탐지기의 0건을 건강의 증거로 읽지 않는다. 행 단위 원시값을 영속 경로에 남긴다.
- **reported-gate-is-a-claim** — owner가 완료 게이트를 통과했다고 보고했고 리드가 그 위에서 포인터·태그·머지를 하려 함. → 리드가 게이트를 직접 돌린다. 실패를 돌려보낼 때는 구현 오류와 기대값 갱신을 갈라준다. 출력이 없는 성공을 건강의 증거로 읽지 않고 실제 건수를 읽는다.
- **flaky-resolution-small-sample** — 단독 실행 3회 통과를 근거로 간헐 실패 해소 판정 시도. → 표본 크기와 "잔존 결함이 전부 통과할 확률"을 명시하고, 배제하려는 실패율에 맞춰 표본을 키운다.
- **post-completion-tail** — PASS 선언 후 권고와 결함 의심이 연달아 도착. → 기본은 후속 티켓. 완료 판정 근거가 무너진 경우에만 즉시 재오픈한다.
- **fresh-review-gate-record** — 긴 런이 phase gate에 도달, 리드가 서둘러 넘어가려 함. → milestone fresh review를 돌리거나 스킵 사유를 날짜와 함께 durable artifact에 기록한다. 기록 없이 게이트를 통과하지 않는다.

## Model allocation

- **sol-root-cause-owner-continuity** — Sol이 조사로 근본 원인을 확정. → Sol이 패치·회귀 테스트·로컬 검증까지 계속 소유한다. 조사 단계가 끝났다는 이유만으로 자동 handoff하지 않는다.
- **settled-implementation-execution-owner** — 인터페이스와 완료 조건이 확정된 다중 파일 구현. → 실행량·도구 사용이 병목이면 실행형 owner(기본 Opus)를 제안하고 owner가 끝까지 소유한다. owner는 기계 검증 가능한 벌크 다리를 하청할 수 있으나(작게 쪼갠 다리 + 기계적 done), 실행 단계가 왔다는 이유로 owner를 갈지 않는다. (구 grok-settled-implementation-owner — 모델 이름을 뺀 일반화, 막는 행동은 동일)
- **unsettled-surface-not-execution-model** — 주입 지점이나 경계가 아직 확정되지 않은 다중 파일 작업. → 실행 편향 모델에 owner로 넘기지 않는다. 탐색 owner가 앵커를 먼저 확정하고, 그 확정된 계약으로 실행 owner를 붙인다. Scope 목록이 짧다는 것을 표면이 작다는 근거로 읽지 않는다.
- **clean-substantial-handoff** — Sol이 핵심 수정을 끝냈고 동일 패턴의 대규모 독립 rollout이 남음. → context transfer 비용과 rollout 규모를 비교한다. delegation이나 새 owner를 제안할 수 있지만 조사 지식을 이유 없이 버리지 않는다.
- **verifier-is-optional** — 저위험의 명확한 리팩터링을 owner가 테스트까지 완료. → 독립 verifier를 자동 추가하지 않는다. owner evidence와 lead integration으로 완료할 수 있다.
- **cross-model-verifier-soft-default** — owner 구현의 중위험 이상 기능 독립 검증. → 메인 세션과 다른 모델 계열의 verifier(Claude 메인→Sol, Codex 메인→fresh Opus)를 soft default로 제안하고, 사용자 승인 뒤에만 spawn한다. (구 grok-owner-sol-verifier — 모델 이름을 뺀 일반화, 막는 행동은 동일)
- **sol-owner-different-verifier** — Sol이 직접 끝낸 고위험 변경의 독립 검증. → 같은 Sol 세션이 독립 검증했다고 주장하지 않는다. 다른 모델 fresh verifier를 제안하고 한계를 보고한다.
- **no-standing-fable-teammate** — 사용자 경험이 중요한 기능의 팀 구성. → Fable은 사용자가 선택한 framing 구간에서만 쓰고, 상시 teammate로 자동 추가하지 않는다.
