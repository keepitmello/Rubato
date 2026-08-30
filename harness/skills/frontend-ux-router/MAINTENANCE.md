# Maintenance Playbook

이 문서는 스킬을 **고치는 사람**(디스패처 세션의 Claude, 또는 사람)을 위한 것이다.
Codex 워커는 이 파일을 읽지 않는다 — SKILL.md 라우팅 테이블에 등록하지 말 것.

## 배경

- 이 스킬은 Codex가 프론트엔드를 데이터-퍼스트로 만드는 실패(주석 같은 카피, 사용자
  여정 부재, 클러터)를 막기 위해 존재한다. 원점이 된 사고 기록:
  `references/task-design-failure-case-study.md` (2026-07-12, Arcaea 채보 검수 UI).
- 라이브 사본: `~/.codex/skills/frontend-ux-router/` (Codex가 실제로 로드하는 위치)
- 공유 레포: https://github.com/keepitmello/frontend-ux-router (gh 계정: keepitmello)
- 디스패처 쪽 연동: `~/.claude/skills/meight/SKILL.md`의 "Fresh-Eyes UI Review" 절.
  워커가 `IMPLEMENTED, FRESH-EYES PENDING`을 보고하면 디스패처가 컨텍스트 없는
  리뷰어를 돌리고, PASS 기록이 있어야 `VERIFIED`를 인정한다.

## 개선 루프 (개판 발견 → 스킬 강화)

입력은 셋 중 하나다: 사용자의 "이거 개판이네" 보고, fresh-eyes 리뷰어의 FAIL
트랜스크립트, 또는 배포 전 자체 발견.

### 1. 증거를 그 자리에서 확보

식은 뒤 재구성하면 케이스 스터디의 가치(구체성)가 사라진다. 즉시 수집:

- 렌더된 화면 스크린샷 (문제 상태 그대로)
- 사용자가 정확히 뭐라고 지적했는지 (원문)
- 워커가 시도한 패치들의 순서와 각 패치가 왜 실패했는지
- fresh-eyes FAIL이면 리뷰어의 원문 답변 전체 (그 자체가 미니 케이스 스터디다)

### 2. 진단: 어느 층의 실패인가

| 질문 | 답이 yes면 |
|---|---|
| 기존 게이트(버짓/금지어/deletion pass/fresh-eyes)가 잡았어야 하는 실패인가? | **집행 문제.** 스킬을 고치지 말고 왜 게이트가 안 돌았는지 추적 — 워커가 스킬을 로드 안 했나, 디스패처가 fresh-eyes를 생략했나, 브리프에 `$frontend-ux-router` 명시가 빠졌나. |
| 게이트는 돌았는데 형식적으로 통과됐나? (path card 기계적 작성, 빈 삭제 목록 등) | **규칙의 검증 가능성 문제.** 해당 규칙을 판단 기반 → 기계 확인 가능(숫자, 목록, 산출물 요구)으로 바꾼다. |
| 어떤 규칙도 이 실패를 다루지 않나? | **새 실패 모드.** 3단계로 — 케이스 스터디를 쓰고 규칙으로 증류한다. |

### 3. 케이스 스터디 작성

`references/task-design-failure-case-study.md`를 템플릿으로 사용. 필수 골격:

1. 사고 맥락 (제품/사용자/구현 상황)
2. 사용자가 실제로 필요했던 것 (한 문단)
3. 실패 타임라인 — **각 패치 시도가 왜 실패했는지**가 핵심 자산
4. 근본 원인 패턴 (failure signature + correction 형식)
5. SKILL.md용 압축 규칙 후보

저장: `references/<slug>-case-study.md` → SKILL.md 라우팅 테이블에 한 줄 등록.

### 4. 규칙으로 증류

케이스 스터디에서 본편으로 끌어올릴 때의 우선순위:

1. `frontend-creation.md` §2 하드 버짓 또는 §4 금지어 목록에 **숫자/목록으로** 추가
2. stop-and-redesign 트리거에 새 시그니처 추가
3. SKILL.md Non-negotiables는 정말 load-bearing할 때만 (10개 이하 유지)

### 5. 동기화

```bash
# 로컬이 source of truth. 수정은 항상 ~/.agents/skills/frontend-ux-router/에서.
cd $(mktemp -d) && gh repo clone keepitmello/frontend-ux-router repo && cd repo
rsync -a --delete --exclude .git --exclude README.md ~/.agents/skills/frontend-ux-router/ .
git add -A && git commit -m "<what failure this addresses>" 
gh auth switch --user keepitmello && git push && gh auth switch --user mysubb01
```

README.md는 레포에만 있다(rsync에서 exclude). 스킬 구조가 바뀌면 README도 수동 갱신.

### 설치 위치 (2026-07-28 통합)

실물은 `~/.agents/skills/frontend-ux-router/` 하나. 아래 4곳은 전부 여기로 걸린 심링크다.

```
~/.claude/skills/                            (Claude 전역)
~/.codex/skills/                             (Codex 전역)
~/.claude/roo-channel/.claude/skills/
~/.claude/companion-channel/.claude/skills/
```

새 위치에 깔 때도 사본을 만들지 말고 심링크를 건다. 사본을 만들면 07-28 이전처럼 6/29·7/2 구버전이 방치된다.

하위 참조 디렉토리의 진입점은 `guide.md`다 — `SKILL.md`로 되돌리지 마라. 중첩 `SKILL.md`가 없어야 Claude 스킬 로더가 최상위 하나만 스킬로 잡는다. SKILL.md 라우트 표가 `references/<name>/guide.md`로 직접 부르므로 이름을 바꾸면 링크가 깨진다.

### 번들된 참조의 upstream 출처

아래 넷은 원래 `~/.agents/skills/` 아래 독립 스킬로도 깔려 있었으나, 라우터를 통해서만 진입하면 되므로 2026-07-28에 독립 사본을 제거하고 이 안의 사본만 남겼다. 번들 사본은 upstream 원본이 아니라 **깨진 상호참조를 이 스킬 구조에 맞게 고친 판본**이다. upstream을 다시 당길 일이 있으면 링크 수정분이 날아가지 않게 diff부터 뜰 것.

| 참조 | upstream |
|---|---|
| `references/software-ux-research/` | https://github.com/vasilyu1983/ai-agents-public (`frameworks/shared-skills/skills/software-ux-research`) |
| `references/nng-ux-heuristics/` | https://github.com/phazurlabs/ux-ui-mastery (`skills/nng-ux-heuristics`) |
| `references/performance-states-patterns/` | https://github.com/phazurlabs/ux-ui-mastery (`skills/performance-states-patterns`) |
| `references/information-architecture/` | https://github.com/aj-geddes/useful-ai-prompts (`skills/information-architecture`) |

제거 전 백업: `~/.agents/skill-backups/standalone-ux-skills-20260728/`

## 설계 원칙 — 미래 세션이 지켜야 할 것

이 스킬이 작동하는 이유는 아래 네 가지다. 개선하다가 이걸 깨면 퇴화다.

1. **형용사 금지, 검증 가능한 규칙만.** "깔끔하게"는 안 먹힌다. LLM은 판단 기반
   규칙을 자기 채점으로 통과시킨다. 숫자 버짓, grep 가능한 금지어, 산출물 요구
   (삭제 목록 제출)만이 실제로 강제된다.
2. **빼기는 명시적 단계여야 한다.** LLM은 스스로 빼지 않는다. deletion pass가
   별도 단계 + 보고 의무인 이유. "빈 삭제 목록 = 건너뛴 것" 조항 유지.
3. **만든 놈과 검증하는 놈 분리.** 구현자는 자기 화면의 이해도를 판정할 수 없다.
   fresh-eyes 리뷰어의 무지가 게이트의 가치 전부다 — 오염(브리프/패스카드 전달)
   금지 규칙을 절대 완화하지 말 것.
4. **구체적 실패 사례가 최고의 교보재다.** "빨간 소리" 같은 실제 실패 예시가
   일반론보다 잘 먹힌다. 증류하면서 사례의 구체성을 버리지 말고, 사례는 사례
   문서에 살려두고 규칙만 본편으로 올린다.

하지 말 것: SKILL.md 비대화(라우터+비협상 규칙만), 판단 기반 조항 추가,
이해 실패를 스킬 문서의 설명 추가로 때우기(제품에서 금지한 걸 스킬에서 하는 셈).

## 백로그 (실전 데이터 확보 후)

- `scripts/copy-lint.sh`: §4 금지어 목록의 grep 자동화 (첫 실전 투입 후)
- fresh-eyes FAIL 트랜스크립트 아카이브 → 반복 패턴이 보이면 규칙 증류
- Codex가 라우터를 실제로 타는지 확인: 첫 디스패치 브리프에 `$frontend-ux-router`
  명시, 보고서에 필수 3필드 + 삭제 목록이 오는지 검사
