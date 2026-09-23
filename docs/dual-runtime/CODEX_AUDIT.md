# Codex 실행 경로 감사

> **2026-09-23 폐기.** Codex 레인(`rubato-codex`)은 쓰지 않기로 하고 레포에서 들어냈다.
> 필요한 자산은 `harness/t3-integration/assets/` 로 옮겼다. 이 문서는 그때의 감사
> 기록이고, 아래의 경로·명령·시험 파일은 더 이상 존재하지 않는다.

## 조사 기준

2026-09-13. 현재 병합 대상 Rubato 기준은 `rubato/base`의 `942c781cb4dfac5129b16108e4dd88bfa2bf3a74`다. 작업 브랜치는 `codex/dual-runtime-checkpoints-20260913`이다.

공식 Codex `main`은 최종 재확인 시 `a592c38c16cdd7623dacc9168926ebccedfb67d3`였다. 최초 상세 감사 기준 `b4c864dd6497ae764e6a826300b34f7ca77ba965` 이후 6개 커밋을 다시 비교했고, 이번 판단에 사용한 app-server 요청 계약/처리기, 역할 설정, app-server 문서에는 변경이 없었다. 따라서 최초 코드 추적 결과를 유지하고 현재 HEAD를 최종 조사 기준으로 기록한다.

- [공식 요청 계약](https://github.com/openai/codex/blob/a592c38c16cdd7623dacc9168926ebccedfb67d3/codex-rs/app-server-protocol/src/protocol/common.rs)
- [공식 요청 처리](https://github.com/openai/codex/blob/a592c38c16cdd7623dacc9168926ebccedfb67d3/codex-rs/app-server/src/message_processor.rs)
- [공식 역할 설정](https://github.com/openai/codex/blob/a592c38c16cdd7623dacc9168926ebccedfb67d3/codex-rs/core/src/agent/role.rs)
- [공식 서버 문서](https://github.com/openai/codex/blob/a592c38c16cdd7623dacc9168926ebccedfb67d3/codex-rs/app-server/README.md)

## 현재 실제 구조

Codex Desktop 및 공식 실행기가 대화와 하위 에이전트를 실행한다. `rubato-codex/scripts/install.mjs`가 플러그인, 기본 지침 및 `agents/taskforce_{owner,verifier,helper}.toml`을 설치한다. `.mcp.json` → `scripts/taskforce-mcp.sh` → `taskforce/src/mcp-server.js`는 작업보드 도구를 노출한다. `taskforce/src/board.js`의 SQLite는 할 일·소유권·완료 증거를 저장하며 대화나 실행기를 저장하지 않는다.

최초 지시의 Core 연결 그림은 책임을 설명하는 개념도다. 이 경로가 Pi의 `packages/rubato-runtime`을 별도 프로세스로 띄워 호출한다는 뜻은 아니다. 운영 계약은 역할·스킬로 공유하고 실행 수명주기는 Codex 네이티브에 맡기는 현재 구조를 유지한다.

외부 모델 선택은 `scripts/providers.mjs`의 `discoverProviderCatalog`/`makeProviderPolicy`, `scripts/opencodex-setup.mjs`, 설치된 OpenCodex와 모델 정책을 따른다. 모델 목록에 이름이 있다고 실제 로그인·호출 성공이라고 판정하지 않는다. 실제 외부 모델 호출은 이번 자동 검사에 포함되지 않는다.

## 감사표

| 분류 | 파일/심볼 | 현재 동작과 공식 근거 | 변경 실익 / 회귀 위험 / 결론 |
| --- | --- | --- | --- |
| KEEP | `taskforce/src/mcp-server.js`: 작업보드 도구 | 작업만 기록한다. native agent lifecycle을 변경하지 않는다. 공식 서버가 thread/turn 요청을 소유한다. | 세션 관리자 제거 대상으로 볼 중복이 없다. 보드 삭제는 Taskforce의 완료 증거를 잃는다. 유지한다. |
| KEEP | `scripts/build-roles.mjs`, `agents/*.toml` | 역할별 지침을 만들고 모델/추론 강도는 고정하지 않는다. Codex 네이티브 역할 설정을 사용한다. | 사용자가 승인한 작업별 모델 배치를 유지한다. 자체 하위 에이전트 실행기를 만들지 않는다. |
| KEEP | `scripts/providers.mjs`: `discoverProviderCatalog`, `resolveProviderSelection`, `makeProviderPolicy` | 선택한 외부 provider와 카탈로그를 읽고 정책에 기록한다. 자격 증명이나 대화 수명주기를 복제하지 않는다. | 추상적인 OpenAI-first 우려만으로 교체하지 않는다. 실제 로그인/호출 검증은 별도로 남긴다. |
| KEEP | `scripts/install.mjs`, `instructions/base.md` | 루트 지침, 플러그인, 네이티브 역할을 관리한다. 런타임이나 도구 스키마를 새로 만들지 않는다. | 공식 역할 기능을 이미 사용한다. 설정 보존·제거 동작을 유지한다. |
| NO_ACTION | thread create/resume/fork/list/read/abort, active state, approval/question, compaction | `rubato-codex`에서 이를 소유하는 독립 세션 관리자를 찾지 못했다. 작업보드 상태는 작업 상태다. | 교체할 중복 primitive가 없다. 보드 상태와 실행 상태를 합치지 않는다. |
| NO_ACTION | `macos/bootstrap.cjs`, `scripts/macos-app.mjs` | 앱 이름·격리 경로·업데이트 메뉴용 포장 코드이며 세션/추론 실행기 패치가 아니다. | 정상 동작하는 Desktop 경로를 이유 없이 바꾸지 않는다. macOS 서명/실기기 검증은 별도다. |
| FIX | `bundle-dependencies.json`: `skillsWithoutExternalSetup` | 설치 목록의 `work-intent`가 의존성 분류에서 빠져 기존 검사가 실패했다. | 외부 설치가 필요 없는 스킬로 추가했다. 실행/역할 정책은 바꾸지 않았다. |
| FIX | `test/skills-bundle.test.mjs` | 생성기는 현재 manifest를 검사하지만 시험이 과거 스킬 개수를 상수로 요구했다. | 기대 개수를 manifest에서 계산하게 바꿨다. 실제 디렉터리/앞머리 정보 검사는 그대로다. |
| SIMPLIFY | 검토 전체 | 작업보드와 대화 저장은 책임이 달라 합치지 않는다. | 추가 단순화 대상 없음. |
| UPSTREAM_REPLACE | 검토 전체 | 세션과 하위 에이전트 실행이 이미 공식 기능을 사용한다. | 추가 교체 대상 없음. Agents API나 별도 실행기로 재작성하지 않는다. |

## 검증

GitHub Actions의 `codex-audit` 작업에서 Node 24.20.0/Linux로 다음 실제 저장소 검사를 실행한다.

```sh
node --test --test-timeout=45000 \
  rubato-codex/test/skills-bundle.test.mjs \
  rubato-codex/test/bundle-dependencies.test.mjs \
  rubato-codex/test/prompts.test.mjs \
  rubato-codex/test/providers.test.mjs \
  rubato-codex/test/package.test.mjs \
  rubato-codex/test/opencodex-setup.test.mjs
```

2026-09-13 최종 브랜치 자동 검사 기준 총 37개, 통과 36, 실패 0, 취소 0, 건너뜀 1, 종료 코드 0이다. 건너뜀은 실제 Codex 바이너리를 요구하는 검사다. 전체 Desktop 설치, macOS 코드서명, 실제 외부 모델 로그인/호출 성공까지 검증했다고 확대하지 않는다.

## 결론

`rubato-codex`는 최신 공개 Codex 기능을 우회하는 별도 session/runtime을 중복 소유하지 않는다. 이번 작업에서 필요한 변경은 의존성 manifest와 낡은 시험 기대값 두 곳뿐이다. Codex Desktop/runtime, Taskforce 의미론, 외부 모델 정책은 그대로 유지한다.
