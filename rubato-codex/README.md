# Rubato Codex

Rubato의 리드·오너 운영방식을 Codex 네이티브 멀티에이전트 위에 얹습니다.
세션과 런타임은 Codex가 관리하고, 이 패키지는 운영 계약과 공유 작업보드를
제공합니다. 별도 Rubato 프로세스는 필요하지 않습니다.

- **네이티브 플러그인:** 여섯 스킬과 `taskforce` MCP.
- **작은 설치기:** 네이티브 오너·검토자·헬퍼 역할과 전역 리드 지침 연결.
- **모델 배분:** 역할별 Sol 고정 없이 리드가 현재 지원되는 GPT 모델과 추론
  강도를 선택합니다. Rubato의 다중 프로바이더 model-guide는 아직 연결하지 않습니다.

## 설치

POSIX shell(`sh`), Node.js 24 이상과 플러그인을 지원하는 Codex가 필요합니다.
현재 검증 환경은 macOS와 Codex CLI 0.153.4입니다. Windows 네이티브 설치는
아직 검증하지 않았습니다. 앱의 내장 CLI와 PATH의 CLI 버전이 다를 수 있어요.
설치기는 호환 바이너리를 찾고, 필요하면 `--codex /path/to/codex`로 지정합니다.

Rubato 저장소 루트에서 실행합니다.

```sh
./rubato-codex/install.sh plan
./rubato-codex/install.sh install
```

설치기는 배포 파일만 Codex 홈의 로컬 스냅샷에 복사한 뒤 네이티브 마켓플레이스로
등록하고 `rubato-codex@rubato` 플러그인을 설치합니다. 개발용 `node_modules`나
원본 저장소의 다른 파일은 이 스냅샷에 포함하지 않습니다. MCP 의존성은
번들에 들어 있으므로 사용자 설치에 `npm install`이나 빌드가 필요하지 않습니다.
실행기는 PATH와 일반 설치 경로에서 호환 Node를 찾습니다. 필요하면
`RUBATO_CODEX_NODE=/path/to/node`로 지정할 수 있습니다.

기존 수동 taskforce 설치에서 옮기는 경우에는 먼저 계획을 확인합니다.

```sh
./rubato-codex/install.sh plan --migrate-legacy
./rubato-codex/install.sh install --migrate-legacy
```

이 옵션은 인식 가능한 이전 taskforce 설치를 백업하고 교체하기 위한 것입니다.
다른 사람이 작성한 역할 파일 등 출처가 불명확한 충돌은 덮어쓰지 않습니다.
공유 스킬의 원본 파일과 보드 데이터도 지우지 않습니다.
기본값과 다른 보드 경로를 사용 중이거나 설정에 TOML 여러 줄 문자열이 있으면
자동 편집을 중단합니다. 기존 데이터를 옮기거나 설정을 덮어쓰지는 않습니다.

별도 Codex 홈에 시험 설치하려면 `--codex-home /path/to/test-codex-home`을
두 명령에 모두 붙입니다. `plan` 또는 `--dry-run`은 적용 계획만 보여줍니다.

설치 후 새 루트 태스크에서 시작하세요. 이미 열린 태스크와 그 자식은 이전
지침·도구 스키마를 유지할 수 있습니다. 플러그인만 설치하면 스킬과 MCP는
제공되지만, 설치기의 전역 리드 지침과 네이티브 역할 등록까지 적용되지는 않습니다.

## 사용

큰 작업에서 “태스크포스로 진행해 주세요”라고 요청하거나, 리드가 서로 독립적인
작업 영역을 발견하면 `agent-taskforce`를 사용합니다. 리드는 모델·역할·담당 영역을
짧게 알리고 각 오너에게 결과와 범위, 예산, 완료 증거를 전달합니다.

한 오너가 조사부터 구현·수정·로컬 검증까지 이어서 맡습니다. 리드는 전체 방향과
통합·최종 판단을 맡고, 독립 검토가 필요한 경우에는 새 컨텍스트를 사용합니다.
작은 수정이나 확인에는 팀이나 보드를 억지로 만들지 않습니다.

| 스킬 | 쓰임 |
| --- | --- |
| `agent-taskforce` | 리드·오너 운영, 네이티브 도구·역할·모델·보드 연결 |
| `dispatching` | 첫 위임과 같은 오너에게 보내는 후속 작업 |
| `dispatched` | 받은 작업의 권한·힌트·예산·반환 계약 |
| `codex-discusser` | 설계와 방향 토론 |
| `codex-reviewer` | 근거에 기반한 독립 검토 |
| `keep-simple` | 원인을 해결하는 가장 작은 구현 |

`taskforce`는 `task_create`, `task_list`, `task_get`, `task_update` 네 도구로
공유 할 일, 소유권, 의존성, 완료 증거를 관리합니다. 에이전트 생성·메시지·대기와
세션 복구는 여전히 Codex 기능입니다. [설계와 Rubato와의 차이](docs/architecture.md),
[보드 API와 상태 경로](taskforce/README.md)를 참고하세요.

## 업데이트·설정·제거

저장소를 원하는 버전으로 갱신한 뒤 같은 설치 명령을 다시 실행합니다.
로컬 스냅샷과 네이티브 플러그인 캐시, 관리 역할·지침을 함께 갱신합니다.
플러그인 UI만 새로고침하면 이 패키지의 외부 역할 파일까지 갱신되지는 않습니다.
업데이트는 자동 실행되지 않으며 기존 작업보드 데이터는 유지합니다.

전역 `AGENTS.md`는 표시된 관리 블록만 추가합니다. 기존 시스템/base 지침,
루트 모델, 권한, hooks를 바꾸지 않습니다. 역할은 `$CODEX_HOME/agents`에,
설치 기록과 백업은 `$CODEX_HOME/rubato-codex`에 둡니다.
`CODEX_HOME`이 없으면 `~/.codex`를 사용합니다.

```sh
./rubato-codex/install.sh uninstall --dry-run
./rubato-codex/install.sh uninstall
```

제거해도 공유 보드의 SQLite 데이터와 백업, 마켓플레이스 등록은 남습니다.
설치 후 사용자가 수정한 역할 파일은 무조건 덮어쓰거나 지우지 않습니다.

## 개발·검증

```sh
cd rubato-codex
npm --prefix taskforce ci
npm test
```

역할 계약을 바꿨다면 `npm run build:roles`, MCP 소스나 의존성을 바꿨다면
`npm --prefix taskforce run build`로 배포 파일도 갱신합니다. `npm test`는
역할·번들 최신 여부와 설치기·보드·실제 MCP 프로토콜을 검사합니다.
테스트는 별도 임시 상태를 사용합니다. 번들의 제3자 라이선스는
[THIRD_PARTY_NOTICES.md](taskforce/THIRD_PARTY_NOTICES.md)에 있습니다.

실제 Codex 바이너리의 설치·캐시 경로·재설치·제거까지 확인하려면 다음을 실행합니다.
이 검사는 임시 Codex 홈을 만들며 모델을 호출하지 않습니다. 일반 `npm test`에서는
건너뜁니다. macOS 앱 외의 바이너리는 `RUBATO_CODEX_TEST_BINARY`로 지정합니다.

```sh
RUBATO_CODEX_NATIVE_E2E=1 node --test test/install-native.test.mjs
```

플러그인 형식은 [Codex 공식 플러그인 가이드](https://learn.chatgpt.com/docs/build-plugins)를
따릅니다. 이 저장소는 Git/로컬 마켓플레이스 배포이며, 공개 플러그인 스토어에
등록되었다는 의미는 아닙니다.
