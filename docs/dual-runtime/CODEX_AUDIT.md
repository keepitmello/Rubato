# CP1 — Codex 실행 경로 감사

## 조사 시점과 범위

2026-09-13. Rubato 기준은 `215b0432a2bb672690203dff8b5ad423d17020df`이며, CP0 소스 묶음 `0933b1d75a4d81d2181ce08270b39c2d334ae5d8`을 실제로 내려받아 조사했다. 사용자 컴퓨터의 미커밋 변경, 로그인 상태, 실행 중 앱은 이번 샌드박스에서 확인하지 않았다.

공식 Codex 조사 기준은 `b4c864dd6497ae764e6a826300b34f7ca77ba965`이다.

- [공식 요청 계약](https://github.com/openai/codex/blob/b4c864dd6497ae764e6a826300b34f7ca77ba965/codex-rs/app-server-protocol/src/protocol/common.rs)
- [공식 요청 처리](https://github.com/openai/codex/blob/b4c864dd6497ae764e6a826300b34f7ca77ba965/codex-rs/app-server/src/message_processor.rs)
- [공식 역할 설정](https://github.com/openai/codex/blob/b4c864dd6497ae764e6a826300b34f7ca77ba965/codex-rs/core/src/agent/role.rs)
- [공식 서버 문서](https://github.com/openai/codex/blob/b4c864dd6497ae764e6a826300b34f7ca77ba965/codex-rs/app-server/README.md)

## 현재 실제 구조

Codex Desktop 및 공식 실행기가 대화와 하위 에이전트를 실행한다. `rubato-codex/scripts/install.mjs`가 플러그인, 기본 지침 및 `agents/taskforce_{owner,verifier,helper}.toml`을 설치한다. `.mcp.json` → `scripts/taskforce-mcp.sh` → `taskforce/src/mcp-server.js`는 네 가지 작업보드 도구를 노출한다. `taskforce/src/board.js`의 SQLite는 할 일·소유권·완료 증거를 저장하며 대화나 실행기를 저장하지 않는다.

최초 지시의 Core 연결 그림은 책임을 설명하는 개념도다. 이 경로가 Pi의 `packages/rubato-runtime`을 별도 프로세스로 띄워 호출한다는 뜻은 아니다. 운영 계약은 역할·스킬로 공유하고 실행 수명주기는 Codex 네이티브에 맡기는 현재 구조를 유지한다.

외부 모델 선택은 `scripts/providers.mjs`의 `discoverProviderCatalog`/`makeProviderPolicy`, `scripts/opencodex-setup.mjs`, 설치된 OpenCodex와 모델 정책을 따른다. 모델 목록에 이름이 있다고 실제 로그인·호출 성공이라고 판정하지 않는다. 실제 외부 모델 호출은 이번 검사에 포함되지 않는다.

## 감사표

| 분류 | 파일/심볼 | 현재 동작과 공식 근거 | 변경 실익 / 회귀 위험 / 결론 |
| --- | --- | --- | --- |
| KEEP | `taskforce/src/mcp-server.js`: `task_create/list/get/update` | 작업만 기록한다. 도구 설명과 보드 코드 모두 native agent lifecycle을 변경하지 않는다. 공식 서버가 thread/turn 요청을 소유한다. | 세션 관리자 제거 대상으로 볼 중복이 없다. 보드 삭제는 Taskforce의 완료 증거를 잃는다. 유지한다. |
| KEEP | `scripts/build-roles.mjs`, `agents/*.toml` | 역할별 developer instructions를 만들고 모델/추론 강도는 고정하지 않는다. 공식 `apply_role_to_config`가 parent-derived config에 역할의 model/effort/instructions를 적용한다. | 사용자가 승인한 작업별 모델 배치를 유지한다. 고정 모델 도입은 기존 의미를 바꾸므로 하지 않는다. |
| KEEP | `scripts/providers.mjs`: `discoverProviderCatalog`, `resolveProviderSelection`, `makeProviderPolicy` | 선택한 외부 provider와 카탈로그를 읽고 정책에 기록한다. 자격 증명을 복제하거나 별도 모델 실행기를 만들지 않는다. 공식 서버도 기존 thread의 provider configuration을 유지한다. | 추상적인 OpenAI-first 우려만으로 교체하지 않는다. 실제 로그인/호출 검증은 별도로 남긴다. |
| KEEP | `scripts/install.mjs`, `instructions/base.md` | 루트 지침, 플러그인, 네이티브 역할을 관리한다. 런타임이나 도구 스키마를 새로 만들지 않는다. | 공식 역할 기능을 이미 사용한다. 설정 보존·제거 동작을 유지한다. |
| NO_ACTION | `rubato-codex` 내 thread create/resume/fork/list/read/abort, active state, approval/question, compaction 조사 | 해당 기능을 실행하는 독립 세션 관리자를 찾지 못했다. 지침과 참고 문서에서 Codex 소유로 위임하며 보드의 상태는 작업 상태다. 공식 요청 계약/처리기가 thread와 turn 동작을 맡는다. | 교체할 중복 primitive가 없으므로 수정하지 않는다. 보드 상태와 실행 상태를 합치지 않는다. |
| NO_ACTION | `macos/bootstrap.cjs`, `scripts/macos-app.mjs` | 저장소에는 앱 이름·격리 경로·업데이트 메뉴용 포장 코드가 있다. 이것을 세션/추론 실행기 패치라고 취급하지 않는다. | 사용자의 정상 동작 경로를 이유 없이 바꾸지 않는다. macOS 서명/앱 검증은 미실행이며 이번 변경 대상이 아니다. |
| FIX | `bundle-dependencies.json`: `skillsWithoutExternalSetup` | 설치 목록에 새 `work-intent`가 있지만 의존성 분류에 빠져 있어 기존 `dependency manifest accounts for every installed skill` 검사가 실패했다. | 외부 설치가 필요 없는 스킬로 한 줄 추가한다. 실행/역할 정책 변경이 없다. 기존 실패 검사가 수정 뒤 통과했다. |
| FIX | `test/skills-bundle.test.mjs`: deterministic/current 검사 | 생성기는 26개 원본을 검사하지만 시험이 25를 상수로 요구했다. | 기대 개수를 현재 manifest의 managed+conditional+preserved에서 계산한다. 생성기 자체의 실제 디렉터리 검사는 그대로 남겨 시험을 무력화하지 않는다. |
| SIMPLIFY | 검토 전체 | 중복처럼 보이는 작업보드와 대화 저장은 책임이 달라 통합하지 않는다. | 이번 감사에서 추가 단순화 대상은 채택하지 않았다. |
| UPSTREAM_REPLACE | 검토 전체 | 세션·하위 에이전트 생성이 이미 공식 기능을 사용한다. | 추가 교체 대상이 없다. Agents API로 재작성하지 않는다. |

## 실행한 검사

Node 24.20.0, Linux, 실제 저장소 파일과 임시 파일시스템을 사용했다. 설치기/외부 실행 경계에는 기존 시험용 실행기를 사용한다. 실제 Codex Desktop 및 유료 모델 호출을 실행한 결과가 아니다.

첫 전체 `node --test rubato-codex/test/*.test.mjs`의 로그는 87개 중 통과 81, 실패 2, 취소 1, 건너뜀 3을 보고했다. 이 호출을 감싼 도구는 시간 초과를 반환했다. 실패 2개가 위 수정 대상이고, `install.test.mjs`의 pending Promise 취소는 이 시점에서 해결됐다고 주장하지 않는다.

수정 뒤 실행:

```sh
node --test --test-timeout=45000 \
  rubato-codex/test/skills-bundle.test.mjs \
  rubato-codex/test/bundle-dependencies.test.mjs \
  rubato-codex/test/prompts.test.mjs \
  rubato-codex/test/providers.test.mjs \
  rubato-codex/test/package.test.mjs \
  rubato-codex/test/opencodex-setup.test.mjs
```

결과: 총 37개, 통과 36, 실패 0, 취소 0, 건너뜀 1, 종료 코드 0. 건너뜀은 실제 Codex 바이너리를 요구하는 검사다. 전체 설치·macOS·MCP 검사 완료로 확대하지 않는다.

이 체크포인트는 Codex 감사와 두 최소 수정까지다. Pi 서버 및 T3 통합 완료를 뜻하지 않는다.
