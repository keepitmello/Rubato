# Rubato → Codex

Rubato의 운영 계약을 가져오되 세션 런타임은 Codex에 맡깁니다.
별도 하네스, 세션 관리자, 메시지 브로커, 모델 실행기는 만들지 않습니다.

| 역할 | 담당 |
| --- | --- |
| 세션·컨텍스트·에이전트 생성·메시지·이어하기·대기 | Codex 네이티브 |
| 전체 방향·범위·통합·최종 판단 | 리드 + `agent-taskforce/LEAD.md` |
| 한 영역의 조사·구현·수정·로컬 검증 | 계속 유지되는 `taskforce_owner` |
| 별도 컨텍스트의 독립 검토 | `taskforce_verifier` |
| 작은 조사·확인·정해진 작업 | `taskforce_helper` 또는 로컬 처리 |
| 위임의 권한·힌트·예산·반환 계약 | `dispatching` / `dispatched` |
| 공유 할 일·의존성·소유권·완료 증거 | `taskforce` 로컬 MCP |
| 모델·추론 강도·provider route 선택 | 리드 + `model-guide` + 설치된 routing 정책 |

## 설치 경계

Codex 플러그인은 manifest로 생성된 portable/조건부 스킬 번들과 MCP를 제공합니다.
`return`, `rubato-tui-verify`, `wrapping-sessions`는 Rubato 경로에서만 적용되는
조건부 참고 계약이며 Codex native 완료·UI·세션을 대체하지 않습니다. 전역 `AGENTS.md`와
네이티브 에이전트 역할 등록과 root instructions는 플러그인 자산으로 자동 적용되지
않으므로 설치기가 `AGENTS.md` routing, native roles, `model_instructions_file`을
명시적으로 연결합니다. 기존 instructions는 백업·충돌 검사 없이 덮어쓰지 않으며,
Codex 시스템 prompt 전체, 모델, 권한, hooks를 바꾸지 않습니다.

역할 파일은 스킬의 오너·검토자 계약과 `dispatched`로부터 생성합니다.
역할 파일은 모델이나 추론 강도를 고정하지 않습니다. 지원되는 네이티브 역할을 선택하면
그 계약이 developer instructions로 들어갑니다. 오래 열린 루트의 도구 스키마에는
새 역할이 없을 수 있으므로 설치 후 새 루트에서 사용합니다. 계약을 brief로
전달하는 호환 경로를 네이티브 역할 주입이 검증된 것처럼 보고하지 않습니다.

`instructions/base.md`는 root instructions의 생성 원본이고, 설치기가 연결한
`model_instructions_file`이 새 루트 세션에 로드되는 실행본입니다. role별
`developer_instructions`는 이 root 계약과 별개의 입력입니다. 설치 검증은 실제 로컬
request에서 base 내용과 Codex 도구·환경 보존, 서로 다른 role config 수용을 확인하지만,
이미 열린 세션의 자동 갱신이나 시스템 prompt 전체 교체를 뜻하지 않습니다.

## 스킬 의존성 경계

[`bundle-dependencies.json`](../bundle-dependencies.json)은 각 스킬을 managed setup,
외부 readiness, 외부 setup이 없는 항목 중 하나 이상으로 연결합니다. 계획 단계는
PATH·플랫폼·번들 파일만 읽고 네트워크, 로그인, package install을 실행하지 않습니다.
적용 단계는 현재 다른 설치와 충돌하지 않는 Codex 전용 Outpost CLI link, version-pinned
public browser CLI prefix, `insane-search` managed venv/launcher를 만듭니다. macOS에서
Aside가 없고 Homebrew가 있으면 공식 cask 설치도 계획합니다. Codex 전용 link는 설치
스냅샷의 bundled launcher를 가리키며 제거 시 source/marker가 일치할 때만 정리할 수
있도록 ownership metadata를 남깁니다.

OpenCodex 준비와 provider 선택은 installer/provider 모듈이 소유합니다. Aside와
Outpost는 설치된 CLI, Aside account 초기화, ChatGPT 로그인까지 갖춰져야 실제 사용
가능합니다. browser fallback, `insane-search` renderer, macOS Computer Use, private
image proxy, 다른 호스트의 `codex-peer`는 선택적·OS별·credential별 준비를 별도
readiness로 보고합니다. 번들 설치 성공을 이 기능들의 E2E 성공으로 확대하지 않습니다.

## 모델과 provider 경계

모델·effort·역할 정책의 정본은 `skills/model-guide/SKILL.md`입니다. 팀 리드는
스폰 전에 roster를 확인받되, 같은 승인 작업의 correction에는 새 승인을 만들지
않습니다. 오너/워커 허용 범위나 Fable/Astra 승인 조건을 역할 파일·설치기·이 문서에
서로 다른 규칙으로 복제하지 않고 model-guide를 따릅니다.

설치기가 만드는 `$CODEX_HOME/rubato-codex/providers.json`은 OpenCodex에서 발견된
provider 중 사용자가 선택한 route와 당시 카탈로그를 기록합니다. provider config나
credential을 복사하지 않고 shared proxy 사용을 강제하지도 않습니다. 외부 로그인과
실제 모델 가용성 검증은 별도입니다. 특히 현재 Codex native agent schema가 GPT 계열만
노출한다면 policy에 Anthropic 등을 등록한 것과 그 모델로 에이전트를 실행한 것은 다른
상태입니다. 완료 증거에는 요청한 모델이 아니라 런타임이 실제로 보고한 모델을 씁니다.

## 공유 보드

보드는 `workspace`와 원래 루트의 `run_id`로 격리됩니다. 자식 에이전트도
같은 값을 사용합니다. 실제 메시지와 후속 작업은 계속 Codex로 전달합니다.
보드의 `actor`는 협업용 표기이며 인증된 신원이 아닙니다. 완료 상태 역시
에이전트가 멈췄다는 뜻이 아니라, 지정된 완료 증거가 기록됐다는 뜻입니다.

SQLite 상태는 소스·플러그인 캐시 밖에 둡니다. 기본 경로는
`$CODEX_HOME/taskforce`이며, `CODEX_HOME`이 없으면 `~/.codex/taskforce`입니다.
명시적인 `TASKFORCE_STATE_DIR`가 최우선입니다. 설치·제거는 이 데이터를 지우지
않습니다. 작은 작업에는 보드를 만들지 않습니다.

## 의도적으로 가져오지 않은 것

- 외부 provider 로그인·credential 복제와 shared proxy 강제 접근통제.
- Rubato 고유 세션 목록·상태 UI·런타임 확장. 대응 기능은 Codex를 사용합니다.
- 역할마다 고정된 모델, 자동 모델 교체, 별도 스케줄러·상주 서비스.
- 보드 자체의 에이전트 실행·생존 판정·인증·원격 동기화.

provider route를 선택했다는 이유만으로 다른 모델 계열의 검증이라고 하지 않으며,
요청된 모델·카탈로그 등록·실제 런타임이 확인해 준 모델을 구분합니다. 보드와 오너
계약은 provider와 무관하게 Codex native 실행 위에 그대로 유지됩니다.
