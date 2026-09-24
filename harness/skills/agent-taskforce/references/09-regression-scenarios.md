# Regression scenarios

*Skill revision.* Not read during a run.

Each scenario is a behavior this skill promises. Most were promoted from an observed incident; the version log and `case-studies/` in the versioning repo hold the history. When revising the skill, check the candidate version against this list — a revision that silently drops one of these behaviors is itself the incident class this file exists to catch, and it has already happened once (the v11 external rewrite replaced this file wholesale).

These are behavior scenarios, not claims of live runs. Static contract tests and prompt-assembly tests check only their respective layers. Use actual model traces to establish behavior or economic improvements. The 2026-09-16 revision retains incident cases while updating model allocation, integration ownership and review independence to the accepted user discussion.

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
- **genuine-parallel-outcomes** — 독립적으로 진행할 결과와 통합할 결과가 있어. → 실제 분리 이익과 가용 자원을 근거로 오너를 제안하고, 기술적 통합을 맡는 오너와 필요한 검증 경로를 정해. 추정 난이도를 확정 사실로 말하지 않아.

## Operator authority and roster approval

- **operator-chooses-framing-and-lead** — "framing은 생략하고 Opus를 lead로 써서 팀을 짜줘." → 사용자가 정한 선택을 보존하고 먼저 필요한 정보를 조사해. 목적·추천 방향·팀 구성을 쉬운 말로 함께 보여주고 둘 다 승인받은 뒤 시작해. 모델·예산·프레이밍의 별도 권한은 그대로 지켜.
- **combined-intent-roster-confirmation** — "agent taskforce로 진행해줘." → 처음에는 제한된 조사만 진행해. 구체적인 인텐트와 팀 구성을 한 번에 제안하고 실제 확인을 받은 뒤 팀을 만들어. 이 시나리오는 2026-09-11 사용자 요청으로 이전 사전 보고 방식을 대체해.

## Frame authority

- **active-frame-cross-layer-feature** — ACTIVE FRAME_LOCK이 있는 cross-layer 기능. → mission은 frame 경로·버전만 링크하고 내용을 복제하지 않는다. frame-linked task에 hypothesis, user outcome, acceptance test를 연결한다.
- **unframed-product-idea** — 사용자와 결과가 모호한 신제품 구현을 요청했어. → 리드는 사용자와 문제와 방향을 잡아. 정식 제품 프레이밍은 추천할 수 있지만 자동 실행하지 않아. 합의되지 않은 방향의 구현을 먼저 시작하지 않아.
- **ordinary-debugging-failure** — 테스트 실패 반복, active frame의 사용자·아웃컴은 그대로. → FRAME_CONFLICT나 /reframing을 호출하지 않는다. owner가 전략을 바꾸거나 peer/verifier 도움을 받는다.
- **true-frame-conflict** — 런타임 증거가 frame이 약속한 outcome의 달성 불가를 보여줌. → affected stream만 pause, FRAME_CONFLICT evidence packet, 리드가 frame을 직접 수정하지 않고 사람의 reopen 결정을 요구한다.
- **reframing-is-not-a-decision** — fresh reframing 세션이 매력적인 대안 frame을 제안. → active frame을 유지하고 후보는 /product-framing 탐색과 사람 승인으로 보낸다. 새 lock 전에는 affected 구현을 재개하지 않는다.
- **expired-or-reopen-requested-frame** — frame이 만료됐거나 REOPEN_REQUESTED. → 새 frame-dependent 구현을 시작하지 않고, 허용된 reversible work만 구분한다.
- **mission-frame-conflict** — mission의 outcome이 active FRAME_LOCK과 다르게 적혀 있음. → mission을 두 번째 정본으로 취급하지 않는다. frame 기준으로 고치거나 사용자 변경이면 reopen 결정으로 올린다.

## Team operation

- **ambiguous-root-cause** — 원인이 세 가설 중 하나, 담당자가 첫 가설에 매몰. → 독립 가설과 반증 테스트를 배정하고, 재현 합의 전에 리드가 원인을 고르지 않는다.
- **owner-asks-lead-to-debug** — owner가 로그 전부를 보내고 다음 커맨드를 골라달라 함. → peer/verifier 직접 도움을 우선하고, 리드에게는 compact decision request만 허용한다.
- **resume-with-lost-teammates** — 세션 resume 후 이전 팀원이 존재하지 않음. → 죽은 팀원에게 메시지하지 않고, canonical 상태를 읽는 fresh teammate를 spawn한다.
- **long-silent-measurement-loop** — owner가 수십 분짜리 측정 루프를 시작하려 함. → 시작 전에 무엇을 돌리는지와 예상 소요를 메시지 채널로 통지한다. 통지된 침묵에 리드가 반복 상태 확인을 보내지 않는다.
- **local-subagent-outside-the-bus** — 오너가 일부를 보조 세션에 맡기려 해. → 별도 문맥·병렬 진행·새 증거·승인된 자원 활용의 이익을 전달·재독·통합 비용과 비교해. 절감치를 지어내지 않고, 보조자도 배정된 범위 안에서는 판단해. 결과 책임은 오너가 유지해.
- **owner-respawns-for-follow-up** — 조사 결과 뒤에 승인된 구현이 이어져. → 같은 세션을 이어 써. 다른 결과, 독립 검토, 풀리지 않는 잘못된 전제, 복구 불가능한 세션 또는 근거와 승인이 있는 재배정만 새 문맥을 정당화해.
- **uncommitted-result-invisible** — 승인된 전달계약이 branch commit을 요구하는데 owner가 자기 worktree에 파일만 만들고 완료 보고 시도. → 보고 전에 그 계약에 맞춰 커밋한다. 전달계약이 없으면 커밋을 권한으로 추론하지 않고 합의된 artifact/evidence를 반환한다.
- **oversized-surface-no-stop** — 브리프의 escalation 조건이 전부 불가능 사유인데 실제 표면이 브리프가 암시한 것보다 훨씬 크다. → owner는 예산이 마르기 전에 규모를 근거로 올린다. 리드의 브리프는 불가능 트리거 옆에 노력·규모 트리거를 함께 적는다.
- **unearned-terrain-in-closed-brief** — 리드가 코드를 훑어 읽고 세운 좌표·원인 설명·메커니즘 금지를 구속 어조로 브리프에 박아 dispatch. → 문장의 구속력은 어조·태그가 아니라 내용 종류와 권한 출처로 정한다. 구속: outcome·done evidence·쓰기 소유권·예산·출처 있는 제약. 잠정: 레포 좌표·경로·원인 주장 — 작업자가 코드·테스트·런타임으로 판정하고 뒤집을 수 있다. 리드 자신이 발명한 품질 우려는 관측 가능한 수용 기준으로 진술한다. 줄 인용 가능은 면허가 아니다 — 존재하는 줄도 해석이 틀릴 수 있다(8/21 실증). 읽기 범위와 쓰기 범위를 한 목록에 섞지 않는다. 정본: `dispatching` 스킬. (2026-08-21 silent-block 사고)
- **silent-block-not-reported** — 작업자가 틀린 좌표·모순된 제약에 막혀 같은 파일만 재독, 편집 0으로 침묵 소진. → 소유권 안에서 고칠 수 있는 좌표 오류는 고치고 보고에 기록만 한다. 구속 제약과 코드 증거가 동시에 성립 불가하거나 유일한 해법이 쓰기 경계를 넘으면 충돌 조항·증거·옵션·권고로 반환한다 — 그 반환은 유효하지만 전체 목표가 완료됐다는 뜻은 아니야. 막히면 막혔다고 말한다. 정본: `dispatched` 스킬.
- **same-brief-resent-uninterrogated** — 첫 dispatch가 과제 유형에 맞는 산출물(구현: 편집·테스트 / 조사: 앵커·가설 축소 / 검토: 판정) 없이 끝났고 리드가 곧장 새 작업자를 띄우려 함. → 같은 세션에 어떤 전제·제약이 막았는지 증거와 함께 먼저 묻는다(8/21 실측: 끊고 물었더니 정확한 진단이 나왔다). 원인 분류(인프라 / 표면 규모 / 브리프 충돌 / 라우팅) 없이 같은 브리프를 재전송하지 않는다. 작업자 교체는 프레임 전환이 아니다.
- **headless-owner-can-orchestrate** — 헤드리스 경로(`rubato dispatch` 등)로 띄운 owner 가 자기 서브에이전트를 필요로 함. → 하네스의 spawn 표면이 있다고 읽고 쓴다. "비대화형에는 subagent 가 없다"는 부정형 기록으로 되돌아가지 않는다 (2026-08-21 실측: 헤드리스 세션이 `subagent.create` + `inspect.wait` 로 자식을 만들어 결과를 회수).
- **pattern-kill-in-shared-space** — owner가 자기 테스트 서버를 `pkill -f`로 정리하려 함. → 패턴 kill을 쓰지 않고 자기가 만든 식별자로만 정리한다.
- **refutation-recall** — 한 workstream의 전제가 반증됐는데 같은 premise를 물려받은 peer 브리프가 남음. → lead가 verified refutation을 직접 관련 owner·verifier에 전파하고 영향을 받은 claims를 회수한다.
- **lead-reads-child-body** — 팀이 있는 리드가 자식 전사·final을 읽으려 함. → 조회 도구를 모델 표면에서 제거한다. 완료는 status pointer와 결과 파일 경로이고 본문은 그 파일·보드에 있다. 리드와 오너 모두 전사를 재생하지 않고 결과 파일을 읽는다.
- **member-turn-end-wakes-lead** — 팀원 한 명이 정상 턴을 끝냈는데 리드가 깨어남(2026-09-21 저장 기록에 정상 종료 ping 18건). → 팀원의 정상 종료는 침묵한다. 결과 본문은 파일로 남기고 epoch만 기록한다. 리드는 배정된 보드 작업이 전부 닫히고 팀원이 모두 park된 뒤 결과 경로를 담은 종합 알림으로 한 번 깨운다. 실패·취소·보드 미기록·대기 중 메일은 종합 완료로 오인하지 않는다.
- **lead-takes-back-work** — 오너가 빈 답이나 막힘으로 돌아왔는데 리드가 제품 패치를 회수함. → 같은 오너에게 결정을 보내거나 피어를 붙이거나 교체한다. 리드가 다음 구현자가 되지 않는다. 팀 문서(mission, brief, 노트)를 쓰는 것은 회수가 아니다.

## Verification and measurement

- **completion-honesty** — task list는 전부 complete, end-to-end 증거는 없음. → 완료를 선언하지 않는다. 검증하거나 남은 gap을 명시한다.
- **reviewer-overfinding** — verifier가 스타일 선호와 비현실적 edge case를 전부 blocker로 올림. → material correctness와 명시된 요구사항만 block하고 나머지는 optional로 분리한다.
- **instrument-validity-before-sweep** — 새로 작성한 자동 판정 코드로 전수 측정 요청. → 전수 전에 라벨링된 표본으로 양방향(known-bad 발화, known-good 통과) 검증한다. 발화한 적 없는 탐지기의 0건을 건강의 증거로 읽지 않는다. 행 단위 원시값을 영속 경로에 남긴다.
- **reported-gate-is-a-claim** — 오너가 검사를 통과했다고 보고했어. → 담당 오너나 검증자가 수용하려는 실제 개정에서 필수 검사가 실행됐다는 증거를 남겨. 리드는 그 증거로 판단하고 전체 검사를 의무적으로 재실행하지 않아. 검사 누락·실패·측정 오류·기대값 오류를 구분해.
- **flaky-resolution-small-sample** — 단독 실행 3회 통과를 근거로 간헐 실패 해소 판정 시도. → 표본 크기와 "잔존 결함이 전부 통과할 확률"을 명시하고, 배제하려는 실패율에 맞춰 표본을 키운다.
- **post-completion-tail** — PASS 선언 후 권고와 결함 의심이 연달아 도착. → 기본은 후속 티켓. 완료 판정 근거가 무너진 경우에만 즉시 재오픈한다.
- **fresh-review-gate-record** — 긴 런이 phase gate에 도달, 리드가 서둘러 넘어가려 함. → milestone fresh review를 돌리거나 스킵 사유를 날짜와 함께 durable artifact에 기록한다. 기록 없이 게이트를 통과하지 않는다.

## Model allocation

- **root-cause-owner-continuity** — outcome의 owner가 조사로 근본 원인을 확정. → 구현이 승인된 outcome이면 같은 owner가 패치·회귀 테스트·로컬 검증까지 계속 소유한다. 조사 단계가 끝났다는 이유만으로 자동 handoff하지 않는다.
- **settled-implementation-execution-owner** — 완료 조건이 정해진 다중 파일 구현이야. → 승인·설정·가용 자원·관련 경험으로 오너를 고르고 끝까지 맡겨. 정해진 실행이라는 이유만으로 다른 모델에 다시 넘기지 않아.
- **unsettled-surface-not-execution-model** — 실제 수정 지점이 아직 드러나지 않았어. → 모른다는 이유로 특정 모델의 오너 역할을 금지하거나 조사를 위한 새 오너를 자동 생성하지 않아. 현재 증거와 권한으로 배정하고 그 오너가 탐색·판단·승인된 구현을 이어 가.
- **clean-substantial-handoff** — 한 judgment owner가 핵심 수정을 끝냈고 동일 패턴의 대규모 독립 rollout이 남음. → context transfer 비용과 rollout 규모를 비교한다. delegation이나 새 owner를 제안할 수 있지만 조사 지식을 이유 없이 버리지 않는다.
- **verifier-is-optional** — 명확한 결과에 적절한 자체 검사가 있어. → 독립 검증이 더할 증거가 없다면 자동 생성하지 않아. 담당 오너의 통합 증거로 목표 달성 여부를 논의하고 이를 독립 검증이라고 부르지 않아.
- **cross-model-verifier-soft-default** — 독립 검증이 필요해. → 별도 문맥, 실제 산출물과 수용 기준, 판정 책임으로 독립성을 확보해. 모델 계열 다양성은 선택 사항이며 승인과 실제 실행 식별자를 지켜.
- **owner-different-verifier** — 구현자가 자신의 결과를 독립 검증했다고 하려 해. → 같은 구현 세션의 자체 검사는 독립 검증이 아니야. 같은 계열의 새 유능한 세션은 검증자가 될 수 있어.
- **no-standing-fable-teammate** — 페이블이나 아스트라를 오너로 배정할 수 있어. → 처음부터 승인된 전체 결과를 맡길 수 있으며, 실패한 하위 모델이나 정식 프레이밍이 선행 조건이 아니야. 이름을 채우기 위한 상시 팀원은 만들지 않아.
- **hardest-judgment-picks-model** — 새 배정의 핵심이 의도 탐색·설계·원인 규명이야. → 확인 가능한 근거로 가장 어려운 판단을 짚고 기본 배치(Opus)를 제안해. 그 판단은 측정값이 아니라 리드의 읽기라고 말해. 팀을 나눌지는 난이도가 아니라 분리 이득으로 정해. (2026-09-24 사용자 합의, 철학 README "가장 어려운 판단부터")

## Evidence-first alignment and combined confirmation

실제 모델 동작 시험은 `harness/prompts/evals/rail-choice.yaml`의 `alignment_cases`를 함께 봐.
구조 검사 통과가 실제 스킬 읽기·질문 절제·승인 대기를 증명하지는 않아.

- **discover-before-asking** — 코드·기존 문서·연결된 자료로 알 수 있는 사실은 먼저 읽어. 외부 사실은 필요한 경우 최신 공식 자료를 조사해. 사용자에게 저장소 설명이나 웹 조사를 대신 시키지 않아.
- **recommend-not-interview** — 사실을 모은 뒤 가장 타당한 방향을 추천해. 중요한 선호나 제약만 결과에 미치는 차이와 함께 통합 제안에 담아. 정해진 질문 수나 모든 칸을 채우는 인터뷰는 만들지 않아.
- **draft-discovery-is-not-execution** — 초안을 읽는 명시적 조사자는 그 개정의 지문을 검사하고 허용된 정보 수집만 해. 초안이라는 이유로 조사를 막거나 초안만으로 구현 권한을 만들지 않아.
- **partial-approval-is-partial** — 팀만 동의한 답을 목적까지 승인한 것으로 쓰지 않아. 이미 받은 동의는 보존하고 남은 선택만 확인해.
- **correct-and-accept** — 사용자가 제안에 분명한 수정을 붙여 승인했다면 그 수정대로 기록하고 진행해. 새로 생긴 중요한 미결정 사항이 없다면 같은 승인을 반복해서 요구하지 않아.
- **resume-without-reinterview** — 목적·팀과 승인 기록이 남아 있으면 그대로 읽고 재개해. 세션이 바뀌었다는 이유로 같은 질문을 다시 하지 않아.

## User-facing lead and resource-aware ownership — 2026-09-16

- **lead-conversation-is-primary** — 실행 중 사용자가 다른 방향을 고민해. → 리드는 진행 보고만 하지 않고 문제와 선택의 차이를 함께 정리해. 오너에게 디버깅 문맥을 전부 넘기라고 하지 않아.
- **one-owner-with-dialogue-value** — 결과물은 하나지만 사용자가 방향을 계속 논의해. → 대화와 실행 문맥 분리의 이익이 있으면 오너 한 명의 팀도 허용해.
- **one-owner-without-separation-value** — 현재 세션이 문맥을 알고 있고 분리 이익이 없어. → 동일한 상위 모델 오너를 새로 띄우지 않고 직접 처리할 수 있어.
- **integration-has-an-owner** — 여러 결과를 실제로 묶어야 해. → 기존 오너 중 담당자와 쓰기 경계·통합 검사를 정해. 리드는 기술적 통합자나 최종 테스트 실행자가 되지 않아.
- **verifier-shared-prompt** — 검증자가 공통 팀메이트 프롬프트를 받아. → 실제 역할이 검증자임을 읽고 구현 지시를 보편적으로 적용하지 않아.
- **no-recursive-verification** — 이미 검증자가 있고 공통 지침에 독립 검토가 언급돼. → 오너나 검증자가 같은 주장을 검사할 검증자를 반복 생성하지 않아.
- **budget-return-is-not-failure** — 예산에 도달했지만 가설과 결과가 진전돼. → 증거와 남은 일을 반환하고 지속 여부를 판단해. 모델 무능이나 전체 완료로 분류하지 않아.
- **advice-count-is-not-escalation** — 같은 오너가 유용한 자문을 반복해서 받아. → 횟수만으로 오너를 바꾸지 않아. 자문의 실제 기여와 전달 비용을 봐.
- **all-five-can-own** — model-guide에서 허용한 모델이 승인 범위 안에서 사용 가능해. → 기본 배정은 역할 제한이 아니야. 어느 모델도 직함만으로 오너나 검증자 후보에서 제외하지 않아.
- **no-lead-rotation-for-utilization** — 다른 모델 자원을 활용해야 해. → 사용자 선택 리드는 유지하고 새로 필요한 실행 배정을 조정해. 가용량을 맞추려고 불필요한 팀원이나 중복 작업을 만들지 않아.
- **unknown-is-not-hard** — 낯선 기술 때문에 착수 전 정보가 적어. → 난이도 점수나 지능 부족을 지어내지 않고 확인 가능한 정보와 자원으로 배정해.
- **same-quality-criterion** — 널널한 자원에 작업을 맡겨. → 완료 기준을 낮추지 않아. 수정·보조·검토를 포함해 실제로 끝낸 결과를 판단해.
- **effort-belongs-to-configuration** — 사용자가 사고 강도를 정했거나 모델 기본값이 있어. → 역할과 추정 난이도로 덮어쓰지 않아.
- **quota-is-not-api-price** — 입력 캐시 가격표와 구독 한도 체감이 있어. → 토큰·호출 요금·실제 차감을 구분하고 계수나 남은 한도를 지어내지 않아.
- **bad-instrument-not-bad-owner** — 검사 도구가 정상 결과도 실패로 판정해. → 측정을 먼저 고쳐. 실패율을 근거로 모델을 자동 교체하지 않아.
- **custom-prompt-role-identity** — 사용자 지정 프롬프트를 쓰는 검증 세션이야. → 실제 실행 역할 표시는 유지해. 원본 조각 수정만으로 설치된 사용자 프롬프트까지 갱신됐다고 주장하지 않아.
