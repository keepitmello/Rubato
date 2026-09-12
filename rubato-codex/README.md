# Rubato Codex

Rubato의 리드·오너 운영방식을 Codex 네이티브 멀티에이전트 위에 얹습니다.
세션과 런타임은 Codex가 관리하고, 이 패키지는 운영 계약과 공유 작업보드를
제공합니다. 별도 Rubato 프로세스는 필요하지 않습니다.

- **네이티브 플러그인:** Rubato의 portable 스킬 번들과 `taskforce` MCP.
- **작은 설치기:** 네이티브 오너·검토자·헬퍼 역할과 전역 리드 지침 연결.
- **모델 배분:** [model-guide](skills/model-guide/SKILL.md)를 정본으로 삼아 역할과
  작업에 맞는 모델·추론 강도·선택 provider를 배분합니다.

## 설치

별도 앱은 Rubato 이름·아이콘의 **프로필 런처**입니다. 원본 서명 앱을 수정하지 않고
루바토 전용 프로필·워크플로우로 실행하며, 실행 중 Dock/About 이름은 ChatGPT로 남습니다.
이전 재서명 복제 방식의 시작 충돌을 피합니다. 전체 기능 검증은 별도입니다.

기본값은 **별도 macOS `Rubato.app`**입니다. 기존 Codex의 전역 지침·기본
프롬프트·스킬 설정·세션을 바꾸지 않습니다. 터미널 대화형 설치에서는 두 방식을
선택할 수 있고, Enter 또는 비대화형 실행은 별도 앱을 선택합니다.

```sh
./rubato-codex/install.sh plan
./rubato-codex/install.sh install --target app
# 기존 Codex에 Rubato 운영방식을 적용하려는 경우에만:
./rubato-codex/install.sh install --target codex
```

별도 앱은 `/Applications/Rubato.app`, Codex 상태는 `~/.rubato/codex`,
Electron 상태는 `~/Library/Application Support/Rubato/Codex`에 둡니다.
원본 `/Applications/ChatGPT.app`을 그대로 실행하며 수정하거나 재서명하지 않습니다.
`~/.codex`의 설정·세션은 복사하거나 수정하지 않습니다.
기존 Pi/remote 도구의 사용자 데이터도 이동하지 않습니다. 앱 이름은 **Rubato**이며,
이전 Pi 런타임과 구분할 때만 문서에서 **Rubato Pi**라고 부릅니다.

앱 설치·업데이트·검증 범위와 남은 런타임 확인 사항은
[macOS 앱 안내](docs/macos-app.md)를 참고하세요. 아래 플러그인·전역 설정 적용
설명은 별도 앱의 격리된 홈 또는 명시적인 `--target codex` 대상에 적용됩니다.

### Rubato와 Codex의 정본 구분

Rubato/shared CLI 운영 스킬의 정본은 `~/.agents/skills`이며 `harness/skills`는
그 배포용 사본입니다. Codex의 `agent-taskforce`, `dispatching`, `model-guide`는
이 디렉터리의 `skills/`가 별도 정본이고, 보조 문서까지 Rubato에서 자동 덮어쓰지 않습니다.
일반 공통 스킬만 manifest의 managed 목록을 통해 재사용합니다.

Codex 실행본은 `$CODEX_HOME/plugins/cache/.../rubato-codex/.../skills`에 있습니다.
`$CODEX_HOME/skills`로 공유 taskforce를 연결하는 방식이 아닙니다. 설치기는 공유 중복을
Codex 설정에서만 비활성화하므로 Rubato가 읽는 원본에는 영향을 주지 않습니다.
Rubato의 스킬 설치·번들 스크립트는 Codex의 역할/설정/플러그인을 관리하지 않습니다.

POSIX shell(`sh`), Node.js 24 이상, npm, 가상환경을 만들 수 있는 Python 3와
플러그인을 지원하는 Codex가 필요합니다. 필수 실행기가 없으면 변경 전에 필요한
항목을 알려주고 중단하며, 설치 완료로 표시하지 않습니다.
현재 검증 환경은 macOS와 Codex CLI 0.153.4입니다. Windows 네이티브 설치는
아직 검증하지 않았습니다. 앱의 내장 CLI와 PATH의 CLI 버전이 다를 수 있어요.
설치기는 호환 바이너리를 찾고, 필요하면 `--codex /path/to/codex`로 지정합니다.

Rubato 저장소 루트에서 실행합니다.

```sh
./rubato-codex/install.sh plan
./rubato-codex/install.sh install
```

기본은 Codex native 모델만 사용합니다. 외부 provider를 고르면 설치기는
OpenCodex 2.43을 Codex 전용 managed prefix에 준비하거나 같은 버전의 기존 실행기를
재사용하고, 알려진 provider를 등록합니다. 로그인과 실제 호출 검증은 별도입니다.

```sh
./rubato-codex/install.sh plan --target codex --providers none
./rubato-codex/install.sh install --target codex --providers anthropic,xai
```

`--providers`는 OpenCodex의 지원 registry 또는 현재 설정에서 발견된 provider ID만 받습니다. 선택 결과는
`$CODEX_HOME/rubato-codex/providers.json`에 기록되며, `CODEX_HOME`이 없으면
`~/.codex/rubato-codex/providers.json`입니다. 업데이트 때 옵션을 생략하면 이전
선택을 유지하고, `--providers none`은 native-only로 되돌립니다.

이 파일은 model-guide가 참고하는 **routing 정책**입니다. shared proxy를 강제로
통과시키는 접근통제나 provider 로그인 설정이 아닙니다. 설치기는 OpenCodex의
credential을 읽어 복사하지 않으며, 외부 provider 로그인은 별도로 마쳐야 합니다.
설치 결과에 로그인과 `ocx start` 후속 명령이 나옵니다. 이 설치기는 로그인이나
프록시 시작까지 자동 완료했다고 보고하지 않으며, 기존 프록시를 재시작하지 않습니다.
카탈로그 등록과 선택은 실제 모델 실행 증거도 아닙니다. 현재 Codex agent schema가
그 provider 모델을 노출하지 않을 수 있으므로, 지원되는 실행 표면에서 실제 런타임이
보고한 모델을 확인해야 합니다.

OpenCodex 2.43의 Codex subagent roster는 최대 다섯 모델입니다. 선택 provider의
model catalog가 보이면 설치기가 Sol과 선택 가능한 Fable·Opus·Grok·Flash,
Terra 후보를 최대 다섯 slot에 설정합니다. 기존 roster가 있는 업데이트는 보존하고,
catalog가 비었으면 임의 ID를 쓰지 않고 `pending-catalog`로 남깁니다.
이 catalog는 등록 정보이며, 실제 인증 성공을 증명하지는 않습니다.

```sh
ocx agent subagents status
ocx agent subagents set gpt-5.6-sol,cursor/claude-fable-5-1,cursor/claude-opus-5,xai/grok-4.6,cursor/gemini-3.8-flash
ocx agent subagents clear
```

위 `set` 목록은 수동 확인·복구 예시이며 `$OPENCODEX_HOME/config.json`의
`subagentModels`를 갱신합니다(`OPENCODEX_HOME` 기본값은 `~/.opencodex`). Astra를
승인받아 쓸 때는 다섯 slot 중 하나와 교체하며 lead 모델은 바뀌지 않습니다. 실행 전
`status`와 현재 Codex spawn schema를 다시 확인하세요.

ChatGPT 네이티브 부모(Sol·Terra·Astra)가 라우팅된 자식(Grok·Claude 등)을 띄우려면
OpenCodex가 `multi_agent_mode: v2` + `keep_native_chatgpt_on_v1: ON`이어야 합니다.
설치기가 이 둘을 켜고 `ocx v2 status`로 실제 상태를 읽어 기록합니다. 그렇지 않으면
Codex가 자식 작업을 ChatGPT 백엔드용으로 암호화해 보내 라우팅 provider가
`unreadable_encrypted_agent_task`로 실패합니다. 관측된 OpenCodex 2.48에서는
`ocx agent subagents set`이 이 플래그를 지우므로, roster를 손으로 바꾼 뒤에는
`ocx v2 keep-native-v1 on`을 다시 실행하고 `ocx v2 status`에서 `v2 hybrid`를 확인하세요.

Provider 등록, 모델 roster 등록, 인증, 실제 호출 성공은 각각 다른 상태입니다.
특히 Anthropic 직접 provider는 등록돼 있어도 Rubato의 `setup-token-sub` 방식은 현재
OpenCodex의 `renewableOAuth` local-import와 호환되지 않습니다. 지원되는 별도 로그인
경로를 완료하고 실제 호출 결과를 보기 전에는 Anthropic 사용 가능으로 보고하지 않습니다.

설치기는 배포 파일만 Codex 홈의 로컬 스냅샷에 복사한 뒤 네이티브 마켓플레이스로
등록하고 `rubato-codex@rubato` 플러그인을 설치합니다. 개발용 `node_modules`나
원본 저장소의 다른 파일은 이 스냅샷에 포함하지 않습니다. MCP 의존성은
번들에 들어 있으므로 사용자 설치에 `npm install`이나 빌드가 필요하지 않습니다.
실행기는 PATH와 일반 설치 경로에서 호환 Node를 찾습니다. 필요하면
`RUBATO_CODEX_NODE=/path/to/node`로 지정할 수 있습니다.

스킬 파일 설치와 외부 도구의 **사용 준비 완료**는 구분합니다. 설치·업데이트는
번들된 Outpost 실행기와 public `agent-browser`/`chrome-devtools`, `insane-search`용
격리 Python 환경을 `$CODEX_HOME/rubato-codex` 아래에 준비합니다. 명령도 같은
디렉터리의 `bin/`에만 노출해 Rubato가 관리하는 `$HOME/.local/bin/outpost`와
경쟁하지 않습니다. 명시적으로 `OUTPOST_BIN_DIR` 또는 `RUBATO_CODEX_BIN_DIR`를
쓸 때도 기존 파일을 덮어쓰지 않습니다. 제거할 때는 설치 기록의 source/marker와
여전히 같은 link·managed prefix만 정리할 수 있도록 기록합니다.

macOS에서 Aside CLI가 없고 Homebrew가 있으면 [공식 `aside` cask](https://formulae.brew.sh/cask/aside)로 앱까지 설치할
수 있습니다. 앱 최초 실행·계정 로그인, 브라우저 profile, macOS Accessibility/Screen Recording 권한,
원격 호스트·SSH 설정, private image proxy/유료 credential은 자동으로 만들지 않습니다.
`insane-search`의 핵심 Python 패키지는 version-pinned managed venv에 설치하지만,
선택적 main-content/stealth 패키지와 Playwright/Patchright 브라우저 다운로드는
자동 실행하지 않습니다. 기본 경로는 없는 도구를 만나면 기능별로 degrade하며, installer의 readiness 결과가 `ready`,
`missing`, `manual`, `unavailable` 경계를 보여줍니다. 전체 분류의 정본은
[`bundle-dependencies.json`](bundle-dependencies.json)입니다.

| 기능 | 설치기가 준비하는 것 | 여전히 필요한 것 |
| --- | --- | --- |
| Outpost | Codex 전용 bundled launcher | Aside 최초 실행·로그인과 account skill 확인 |
| Browser CLI | pinned `agent-browser`, `chrome-devtools-mcp`와 `--version` smoke | Cloak shared-process wrapper/profile은 배포 source가 없어 수동 |
| Insane Search | pinned core packages의 격리 venv와 launcher | 선택적 extraction/stealth packages와 browser download |
| Aside | macOS+Homebrew에서 공식 cask | 앱 최초 실행, 로그인, 다른 OS 설치 |
| Computer Use | backend 존재 여부 보고 | macOS backend 설치와 OS 권한 |
| Imagen/remote host | readiness 보고 | private proxy·유료 credential, `codex-peer`·SSH trust |

기존 수동 taskforce 설치에서 옮기는 경우에는 먼저 계획을 확인합니다.

```sh
./rubato-codex/install.sh plan --target codex --migrate-legacy
./rubato-codex/install.sh install --target codex --migrate-legacy
```

이 옵션은 인식 가능한 이전 taskforce 설치를 백업하고 교체하기 위한 것입니다.
다른 사람이 작성한 역할 파일 등 출처가 불명확한 충돌은 덮어쓰지 않습니다.
공유 스킬의 원본 파일과 보드 데이터도 지우지 않습니다.
기본값과 다른 보드 경로를 사용 중이거나 설정에 TOML 여러 줄 문자열이 있으면
자동 편집을 중단합니다. 기존 데이터를 옮기거나 설정을 덮어쓰지는 않습니다.

`~/.agents/skills` 등에 같은 이름의 스킬을 직접 설치해 둔 경우에는 정확한
`SKILL.md` 경로를 `--disable-skill`로 지정합니다. 이 옵션은 여러 번 쓸 수 있고,
계획과 실제 설치에 같은 경로를 넘깁니다.

```sh
./rubato-codex/install.sh plan --target codex \
  --disable-skill "$HOME/.agents/skills/outpost/SKILL.md"
./rubato-codex/install.sh install --target codex \
  --disable-skill "$HOME/.agents/skills/outpost/SKILL.md"
```

설치기는 지정한 원본을 이동·수정·삭제하지 않습니다. 관리되는
`[[skills.config]]` 항목에 그 exact path와 `enabled = false`만 추가해 플러그인
사본과의 중복 로딩을 막습니다. 경로가 실제 bundled skill의 `SKILL.md`가 아니거나
기존 설정이 명시적으로 `enabled = true`면 중단합니다. 이후 업데이트에서도 선택을
기억하며, uninstall하면 관리 블록이 제거되어 보존된 원본 스킬이 다시 활성화됩니다.

앱 없이 별도 Codex 홈에 시험 설치하려면 `--target codex --codex-home /path/to/test-codex-home`을
두 명령에 모두 붙입니다. `plan` 또는 `--dry-run`은 적용 계획만 보여줍니다.

설치 후 새 루트 태스크에서 시작하세요. 이미 열린 태스크와 그 자식은 이전
지침·도구 스키마를 유지할 수 있습니다. 플러그인만 설치하면 스킬과 MCP는
제공되지만, 설치기의 전역 리드 지침과 네이티브 역할 등록까지 적용되지는 않습니다.
저장소의 `instructions/base.md`는 설치 입력이고, 실제 루트는 설치된
`model_instructions_file`을 다음 새 세션에서 읽습니다. 오너·검토자·헬퍼는 각각
설치된 native role의 `developer_instructions`를 읽으므로 서로 같은 prompt가 아닙니다.
이는 Codex의 runtime·tool schema나 변경 불가능한 시스템 prompt 전체를 교체한다는
뜻이 아닙니다.

## 사용

큰 작업에서 “태스크포스로 진행해 주세요”라고 요청하거나, 리드가 서로 독립적인
작업 영역을 발견하면 `agent-taskforce`를 사용합니다. 리드는 모델·역할·담당 영역을
짧은 roster로 먼저 확인받고, 각 오너에게 결과와 범위, 예산, 완료 증거를 전달합니다.

현재 모델 배분과 승인 규칙의 정본은 [model-guide](skills/model-guide/SKILL.md)입니다.
요약하면 오너는 Fable·Opus·Sol·Grok 중에서 고르고 Astra는 어려운 문제의 예외로
둡니다. Terra·Luna는 워커 전용입니다. Fable/Astra는 작업과 effort를 함께 명시해
승인받고, Opus/Sol/Grok은 별도 모델 승인을 요구하지 않습니다. 이미 승인된 같은
작업의 correction은 다시 승인받지 않습니다. Codex-only 환경에서는 Sol 오너와
Terra/Luna 워커를 씁니다.

한 오너가 조사부터 구현·수정·로컬 검증까지 이어서 맡습니다. 리드는 전체 방향과
통합·최종 판단을 맡고, 독립 검토가 필요한 경우에는 새 컨텍스트를 사용합니다.
작은 수정이나 확인에는 팀이나 보드를 억지로 만들지 않습니다.

아래는 핵심 운영 스킬입니다. 설치되는 전체 목록과 portable/조건부/보존 분류는
[`skill-bundle.json`](skill-bundle.json)이 정본이며, 프론트엔드·리서치·브라우저·
프롬프트·제품 프레이밍·DB/React 가이드와 안전한 보조 리소스도 함께 설치됩니다.

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

전역 `AGENTS.md`는 표시된 routing 블록만 추가하고, `model_instructions_file`은
백업·충돌 검사를 거쳐 Rubato base 실행본으로 교체합니다. 교체 대상은 설정 가능한
기본 지침이며, Codex가 별도로 제공하는 도구·권한·환경 지침과 루트 모델·hooks는
유지합니다. 역할은 `$CODEX_HOME/agents`에,
설치 기록과 백업은 `$CODEX_HOME/rubato-codex`에 둡니다.
`CODEX_HOME`이 없으면 `~/.codex`를 사용합니다.

```sh
./rubato-codex/install.sh uninstall --target codex --dry-run
./rubato-codex/install.sh uninstall --target codex
```

제거해도 공유 보드의 SQLite 데이터와 백업, 마켓플레이스 등록은 남습니다.
OpenCodex의 private 실행기와 provider·roster·인증 설정도 보존합니다. 다른 클라이언트나
실행 중인 프록시가 사용할 수 있기 때문입니다. 제거는 Rubato Codex의 관리 설정을
되돌리는 작업이며, 외부 앱과 계정까지 설치 이전 상태로 초기화하는 작업은 아닙니다.
설치 후 사용자가 수정한 역할 파일은 무조건 덮어쓰거나 지우지 않습니다.
최초 설치가 중간에 실패하면 이미 설치한 의존성이 남을 수 있습니다. 같은 설치
명령으로 재시도할 수 있지만, 설치 기록이 저장되기 전 실패에 대한 자동 rollback이나
즉시 uninstall 복구는 아직 보장하지 않습니다.

## 개발·검증

```sh
cd rubato-codex
npm --prefix taskforce ci
npm test
```

원본 harness 스킬을 바꿨다면 `npm run build:skills`, 역할 계약을 바꿨다면
`npm run build:roles`, MCP 소스나 의존성을 바꿨다면
`npm --prefix taskforce run build`로 배포 파일도 갱신합니다. `npm test`는
`check:skills`를 포함해 인벤토리·번들·역할 최신 여부와 설치기·보드·실제 MCP
프로토콜을 검사합니다.
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
