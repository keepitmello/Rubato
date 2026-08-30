---
name: meight
description: "Codex 세션에 작업 통째 위임. worker는 구현, mate는 설계·리뷰."

---

# meight (claude-codex-meight)

오케스트레이팅 에이전트가 Codex 세션을 병렬로 굴리는 하네스. `meight` CLI로 어느 레포에서든 쓴다. 전역 데몬 하나를 레포들이 공유하고, 세션 상태는 호출 레포별로 `<daemon-home>/repos/<repo-key>/` 아래 격리된다. 기본 디스패처는 Claude Code 세션이고, Codex 앱/CLI 세션도 얇은 `~/.codex/skills/meight` 바인딩으로 이 파일을 읽는다 — 교차 모델 디스패처는 감독하는 Codex 워커와 사각지대가 겹치지 않는다.

세션 쪽 계약은 `meight-mate`, `meight-worker`, 공통 프로토콜은 `meight-common` CONTRACT에 있고, 하네스 preamble이 자세에 맞는 스킬 + 공통 계약을 세션에 주입한다.

## 두 자세 — `--mode mate|worker` (필수)

- `--mode mate` — 생각·판단 상대. 블라인드/앵커드 설계, 진단, 방향, 그리고 독립 리뷰. 브리프는 닫을 결정과 리뷰 표면을 주고, mate는 무엇이 중요한지 근거에 따라 판단한다.
- `--mode worker` — 실행 팀원. how·구현·검증·자기 리뷰를 소유하고, 브리프 밖 관찰과 이견을 텍스트와 `QUESTION:`으로 올린다.

| Mode | Model | Effort | Fast | Sandbox |
|---|---|---|---|---|
| `mate` | `sol` | `medium` | off | `full` |
| `worker` | `sol` | `medium` | off | `full` |

### 리뷰 디스패치

정확한 리뷰 표면, 의도한 결과, 제약, 이번 리뷰가 도울 결정을 준다. 무엇을 관찰하고 어떤 비중으로 보고할지는 mate의 독립 판단에 맡긴다. mate는 요청받지 않은 내용이라도 결과를 materially 바꾸는 관찰이나 더 나은 방향을 근거와 함께 올릴 수 있다.

독립 판단 하나면 충분한 리뷰는 mate 하나로 끝낸다. 다른 fresh read가 실제 결정을 바꿀 수 있을 때만 같은 중립 브리프로 mate 하나를 더 병렬 실행하고, 서로의 결론은 공유하지 않는다. 형식적 verdict가 필요하면 브리프에 그 결정만 명시한다.

생략한 설정은 자세와 모델에서 해소되고, dispatch echo가 해소값 전부를 `(default)`/`(set)` 출처와 함께 보여준다. `--model luna`를 명시하면 `luna max`와 Fast로 함께 해소된다. 명시한 `--effort`와 `--fast`/`--no-fast`는 언제나 이긴다. 샌드박스는 어느 자세도 강제하지 않으니 read-only가 필요하면 브리프에 지시한다 (mate 스킬은 "브리프가 시키지 않으면 레포 파일을 고치지 않는다"를 이미 갖고 있다).

`follow`와 `reply`는 세션에 기록된 mode·model·effort·fast를 상속하고 전체 preamble 대신 한 줄 리마인더만 받는다. 값을 명시하면 그 턴부터 이후 턴이 상속하는 값이 된다.

## 모델

`sol`, `terra`, `luna`는 런타임 슬러그로 해소되는 별칭이고 (`gpt-5.6-*`), 전체/커스텀 문자열도 그대로 통과한다. 어느 브레인·effort를 고를지는 디스패처의 상주 정책이 소유한다; 사다리 근거·비용 수치·승급 축은 [`references/model-routing.md`](references/model-routing.md)에 있다.

**이 하네스는 Codex 세션이다.** CLI가 `grok` 별칭과 커스텀 슬러그를 계속 통과시키더라도 여기서 xAI를 고르지 않는다 — xAI 는 rubato 가 직접 잡는다(`rubato dispatch --model xai/grok-4.6`).

## 디스패치 패턴 — 백그라운드 + 통지

`dispatch`는 데몬 자동 기동 → 세션 시작(활성 이름이면 재부착) → `result.md` 출력까지 하는 블로킹 원샷이다. Bash `run_in_background`로 던지면 그 셸의 종료가 태스크 통지를 만들고, 통지 시점에 결과는 이미 디스크에 있다 — 그 위에 폴링을 얹으면 같은 대기를 한 번 더 돌 뿐이다.

```text
Bash(command: "meight dispatch fix-auth --mode worker --cwd ~/repo --brief-file /tmp/brief.md",
     run_in_background: true)
→ 다른 작업 계속
→ 태스크 통지 도착 → meight result fix-auth
→ exit 3이면 → Bash(command: "meight reply fix-auth --brief '...'", run_in_background: true)
```

```bash
meight status                # 활성 + 최근 6시간 terminal / --archived, --all, --all-repos, <name> 상세
meight result <name>         # result.md
meight reply <name> --brief "..."      # 최종 QUESTION에 답하고 재개
meight follow <name> --brief "..."     # 같은 세션의 다음 단계
meight steer <name> "correction"       # 도는 턴에만 꽂힌다; 틈이면 no active turn to steer
meight interrupt <name>                # 세션 종료는 이것으로 — pkill은 이름 매칭이라 셸까지 죽인다
```

이름을 명시한 `status`/`result`/`follow`/`reply`/`steer`/`interrupt`/`watch`는 현재 레포에 없으면 전체 레포 네임스페이스에서 유일한 동명 워커를 찾는다. 동일한 이름이 여러 레포에 있으면 추측하지 않고 대상 레포에서 다시 실행하라고 안내한다. 이름 없는 `status`/`list`/`watch`는 계속 호출 cwd 레포만 보며, 전체 목록은 `--all-repos`를 쓴다.

`follow`는 새 턴만 열고 즉시 반환하는 저수준 명령이다. 백그라운드 완료 통지와 결과까지 한 번에 받으려면 terminal/최종 질문 어느 쪽이든 `reply`를 쓴다. `reply`가 `follow` 뒤에 `--timeout`/`--progress` 대기와 최신 결과 출력을 붙인 원샷 표면이다.

- `--timeout`(기본 1800)은 안전망 체크포인트다. 타임아웃으로 셸이 끝나도 워커는 계속 도니, 같은 `dispatch <name> --mode ...`를 다시 실행하면 재부착해 통지를 다시 만든다 (terminal 행은 재부착 대상이 아니다). `status`가 진실이다.
- 워커가 tool/approval 입력을 기다리며 15초 넘게 멈추면 `dispatch`가 exit 3으로 끝나 통지가 온다. `status <name>`의 `needs_input_source`가 `tool`이면 답할 방법이 없는 대기다 — interrupt 후 브리프를 고쳐 재시작한다.
- provider capacity 에러는 CLI가 같은 설정으로 지수 백오프 재시도한다 (기본 15분 상한, `--timeout`이 더 짧으면 그 시간). 진행은 `status`의 `capacity_retry`와 heartbeat에 보인다.
- `--progress`(기본 300)는 백그라운드 태스크 출력 파일에 heartbeat 한 줄을 쌓는다 (아주 긴 세션이면 `--progress 0`). `--narrate`는 사람이 터미널에서 실시간으로 볼 때만 쓴다.

`status`는 pull-only로 디스크를 읽고, `steer`·`interrupt`·`follow`는 살아있는 데몬이 필요하다. `reply`/`follow`는 데몬 재시작이나 registry GC 이후에도 영속된 `thread_id`를 새 런타임에서 재개한다. terminal 결과 후 다른 워커가 없을 때 데몬이 종료하길 원하면 `--shutdown-when-idle`.

### 브리프 골격

```bash
meight dispatch <name> --mode worker --brief-file - --cwd <dir> <<'EOF'
## Goal       <what this enables + success criteria>
## Decision   <the user decision this phase must close>
## Approval   <approved phase/method/cost envelope; campaign + round number>
## Scope      <file/dir boundary; do not exceed>
## Existing patterns  <file:line pointers; required for good review>
## Constraints <domain rules only; mode/QUESTION policy is injected>
## Stop / Escalate <failed gate, cap, or phase-change conditions>
## Verification <commands to run + expected outcome>
EOF
```

브리프에 담는 것은 **무엇을 가능하게 하려는가, 무엇을 만족해야 끝인가, 경계가 어디까지인가**까지고, how는 워커 몫으로 비워둔다. 디스패처가 절차를 미리 깔면 워커는 더 나은 길을 찾아도 그리 가지 않는다 — 조사 항목·문서 목차·구현 순서를 짜주는 친절이 탐색 공간을 닫아, 산출물은 나와도 발견이 사라진다. UX와 사용자 눈에 보이는 동작은 디스패처 소유 판단이라 수용 계약으로 브리프에 명시한다. mode/QUESTION 정책은 preamble이 주입하니 도메인 규칙과 작업별 제약만 넣는다.

## 결과

모든 세션은 텍스트 결과를 `result.md`에 남기고, 외부 결정이나 진짜 블로커가 있을 때만 마지막 문단에 공통 계약의 `QUESTION:` 형식을 쓴다.

워커는 새로 도입한 필드·옵션·추상화마다 그걸 정당화하는 요구나 사용처를 함께 대게 되어 있다. 그 답이 실제 사용처가 아니라 가정("나중에 필요할지 몰라")이면 그건 요청된 일이 아니니 되돌린다. 그리고 **발주자가 심은 요구도 같은 검사를 받는다** — 쓸데없는 구조가 워커 손에서만 나오는 게 아니라 브리프에 이미 들어 있는 경우가 많다.

## Codex 워커 능력

brief에서 모달리티를 명시적으로 요구하고, 실제로 썼다는 증거를 요구한다: 브라우저 사용(localhost 앱 클릭스루, 반응형 플로우, 스모크, 스크린샷) / computer use(데스크톱 앱·OS UI 조작) / 비전·스크린샷(레이아웃, 텍스트 잘림, 렌더링, 목업, Figma, 프로덕션 캡처) / 에셋·문서 작업(이미지, PDF, 문서, CSV/XLSX) / 리서치(현행 문서, API, 릴리스 노트, 가격, 정책 — 브라우징 가능할 때) / 커넥터 기반 작업(GitHub, Google Drive, Figma, Canva, Hugging Face, Sentry 등 활성화된 것).

## 참조

- 소유권 경계, phase 승인과 campaign identity, `QUESTION:` 라우팅, 학습 루프 원장(decisions/, preferences.md, lessons.md): [`references/ownership-and-escalation.md`](references/ownership-and-escalation.md)
- 설계나 리뷰를 디스패치할 때 읽기 — 블라인드/앵커드 설계, 플랜 리뷰 APPROVE/REVISE, 독립 리뷰와 추가 fresh read, fresh-eyes UI 리뷰, 이견 처리: [`references/design-and-review.md`](references/design-and-review.md)
- 데몬 재시작·epoch 마이그레이션 체크리스트, launchd, 상태 경로, 환경변수, 수명주기 caveat: [`references/daemon-ops.md`](references/daemon-ops.md)
- 모델 사다리 비용 근거, 승급 경로, terra 조건: [`references/model-routing.md`](references/model-routing.md)
