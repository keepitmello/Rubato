# Maintenance Playbook

이 문서는 스킬을 **고치는 사람**(디스패처 세션의 Claude, 또는 사람)을 위한 것이다.
Codex 워커는 이 파일을 읽지 않는다 — SKILL.md 라우팅 테이블에 등록하지 말 것.

## 배경

- 이 스킬은 Codex가 프론트엔드를 데이터-퍼스트로 만드는 실패(주석 같은 카피, 사용자
  여정 부재, 클러터)를 막기 위해 존재한다. 원점이 된 사고 기록:
  `references/task-design-failure-case-study.md` (2026-07-12, Arcaea 채보 검수 UI).
- 라이브 사본: `~/.codex/skills/frontend-ux-router/` (Codex가 실제로 로드하는 위치)
- 공유 레포: https://github.com/keepitmello/frontend-ux-router (gh 계정: keepitmello)
- 디스패처 쪽 연동: 이해도 검토가 계약으로 요구되거나 만든 쪽이 못 보는 사각지대가 클 때 디스패처가
  맥락 없는 리뷰어를 돌린다(`references/fresh-eyes-review.md`). 요구된 검토가 안 돌았으면 통과가 아니라 대기다.

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
| 기존 판단 조건이 다뤘어야 하는 실패인가? | **집행 문제.** 스킬을 고치지 말고 왜 안 먹혔는지 추적 — 워커가 스킬을 로드 안 했나, 요구된 검토를 생략했나, 브리프에 고정 항목이 빠졌나. |
| 조건은 읽었는데 자기 채점으로 넘어갔나? (렌더 안 보고 완료, 고정 값을 주석으로만 보존 등) | **확인 수단 문제.** 문장을 세게 고치지 말고, 그 자리를 검사·스냅샷·실제 렌더 관찰 같은 산출물로 확인할 수 있게 한다. |
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

1. 기존 문단의 판단 조건과 이유를 고친다 — 실패마다 새 규칙을 덧붙이지 않는다
2. 기계로 확인할 수 있는 건 문장 대신 그 제품의 검사로 둔다
3. 사례의 구체성은 사례 문서에 두고, SKILL.md에는 구별해야 할 차이만 올린다

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

1. **판단 조건과 이유로 쓴다.** 번호 규칙·숫자 예산·금지어 목록은 모든 화면에 같은
   무게로 걸려서, 보기 화면에 억지 주 행동을 만들고 예산을 맞추려 승인된 내용을 지우게
   했다. 무엇을 보고 어떤 차이를 구별할지와 그 이유를 쓴다.
2. **꼭 지켜야 하는 건 문장이 아니라 검사로 지킨다.** 사용자가 고정한 값은 어서션·
   스냅샷·이름 붙은 정의로 보호하고, 완료는 렌더된 경로를 실제로 본 것으로 말한다.
   문장 약속은 보호가 아니다.
3. **이해도 검토는 만든 쪽과 분리한다.** 구현자는 자기 화면의 이해도를 판정할 수 없다.
   검토를 돌릴 때는 리뷰어에게 만든 쪽 설명을 먼저 주지 않는다. 다만 모든 수정에
   검토를 붙이지 않는다.
4. **구체적 실패 사례가 최고의 교보재다.** "빨간 소리" 같은 실제 실패 예시가
   일반론보다 잘 먹힌다. 사례는 사례 문서에 살려 두고, 본편에는 구별할 차이만 올린다.

하지 말 것: 실패 하나마다 규칙 덧붙이기, 한 제품의 단어 예시를 전역 금지어로 만들기,
이해 실패를 스킬 문서의 설명 추가로 때우기(제품에서 금지한 걸 스킬에서 하는 셈).

## 백로그 (실전 데이터 확보 후)

- fresh-eyes FAIL 트랜스크립트 아카이브 → 반복 패턴이 보이면 규칙 증류
