# Stock Pi 0.85.1 런타임 경계

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

결론: Rubato가 선택해야 할 배포 단위는
`@earendil-works/pi-coding-agent@0.85.1`의 독립 설치 하나다. 공개 SDK는 unbundled
`dist/index.js`지만, npm `pi` bin과 RPC export는 `dist/bundle/*`를 실행한다. 따라서
Rubato의 파일 단위 패치를 적용한 런타임은 `dist/cli.js` / `dist/rpc-entry.js`를
명시적으로 선택해야 한다. stock bin을 그대로 실행하면 SDK·unbundled 테스트가 green이어도
패치가 실제 CLI/RPC에 반영되지 않는다.

## 확인된 배포와 의존성

기준은 npm 무격리 설치가 아니라 `harness/pi-runtime/`의 독립 lock/install이다.
`@earendil-works/pi-coding-agent`가 가진 shrinkwrap 때문에 suite 의존성은 coding-agent
아래에 중첩 설치되며, Node가 각 importer에서 실제로 고르는 경로를 따라가야 한다.

| package | 선택 버전 | 실제 관계 |
|---|---:|---|
| `@earendil-works/pi-coding-agent` | 0.85.1 | 설치 root의 직접 의존성 |
| `@earendil-works/pi-agent-core` | 0.85.1 | coding-agent 직접 의존성 |
| `@earendil-works/pi-ai` | 0.85.1 | coding-agent와 agent-core 의존성 |
| `@earendil-works/pi-tui` | 0.85.1 | coding-agent 직접 의존성 |
| `@earendil-works/chord` | 0.85.1 | coding-agent와 agent-core 의존성 |
| `@earendil-works/pi-telemetry` | 0.85.1 | agent-core와 pi-ai 의존성 |

Windows용 `.cmd`/`.ps1` launcher 생성에는 direct dependency
`cmd-shim@8.0.0`을 exact pin한다. 설치 manifest 기준 Node 범위는
`^20.17.0 || >=22.9.0`이고 runtime dependency는 없어서 이 harness의 Node `>=24`
하한 안에 들어온다. 이 보조 dependency는 위 stock Pi suite 여섯 package의 identity나
버전을 바꾸지 않는다.

`resolvePiRuntime({ root })`는 이 여섯 edge를 `node:module.findPackageJSON()`으로 실제
해결한다. manifest의 `name`과 버전을 각각 exact match하고, 서로 다른 물리 copy가
선택되거나 `root/node_modules` 밖으로 올라가면 실패한다. 따라서
`@earendil-works/pi-ai` 자리에 `@code-yeongyu/senpi-ai`를 npm alias로 설치한 기존
구성은 이름 불일치로 거부된다. root·`node_modules`·package·entry의 realpath도 모두
경계 안이어야 해서 parent/global/HOME fallback과 symlink escape가 없다.

반환 경로는 다음 두 종류를 일부러 함께 둔다.

| resolver field | 0.85.1 경로 | 의미 |
|---|---|---|
| `sdkEntry` | `dist/index.js` | npm package root의 지원 SDK import |
| `cliEntry` | `dist/bundle/cli.js` | `package.json#bin.pi`, 순정 CLI |
| `rpcEntry` | `dist/bundle/rpc-entry.js` | `exports["./rpc-entry"]`, 순정 RPC export |
| `patchableCliEntry` | `dist/cli.js` | 내부 모듈을 import하는 staged Rubato CLI |
| `patchableRpcEntry` | `dist/rpc-entry.js` | 내부 모듈을 import하는 staged Rubato RPC |

근거는 설치된 `package.json`의 bin/exports/dependencies/engine 선언과
[v0.85.1 원본 package.json](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/package.json)이다.
현재 패키지의 Node 하한은 `>=22.19.0`이다.

## 확인된 공개 계약

- package root는 `createAgentSession`, `createAgentSessionRuntime`, `ModelRuntime`,
  `SessionManager`, `DefaultResourceLoader`, `discoverAndLoadExtensions`, `defineTool` 등
  현재 Rubato adapter가 필요한 SDK/extension 표면을 `dist/index.js`에서 export한다.
  공식 SDK 문서는 package root import를 사용한다.
- CLI는 `--extension/-e`, `--no-extensions`, `--no-context-files`를 지원한다.
  `--no-extensions -e <path>` 조합은 자동 discovery는 끄고 지정 extension은 로드한다.
- 지원 subprocess 계약은 `pi --mode rpc`와 LF-delimited JSONL RPC다. 별도
  `./rpc-entry` export도 존재하지만 0.85.1에서는 bundled entry다.
- 0.85.1 changelog는 local SDK와 stdio RPC가 지원 계약이라고 명시한다. 반대로
  experimental client/server/plugin은 npm 지원 표면에서 제거됐다.

공식 근거:
[SDK](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md),
[RPC](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md),
[extensions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md),
[0.85.1 release](https://github.com/earendil-works/pi/releases/tag/v0.85.1).

## 확인된 배포 구현 (공개 API는 아님)

설치본 `dist/core/extensions/loader.js`는 TypeScript/JavaScript extension을 Jiti로
읽는다. unbundled Node 경로에서는 suite entry에 alias하고, bundled Node 경로에서는
embedded virtual modules를 제공한다. 두 경로 모두 `@earendil-works/pi-*`와 legacy
`@mariozechner/pi-*`를 제공하고, `pi-ai` root를 `pi-ai/compat`에 연결한다.
`@code-yeongyu/senpi` alias는 없다. Rubato extension의 runtime import는 stock 이름으로
바꾸거나 빌드 결과가 stock alias만 요구하도록 만들어야 한다.

실제 npm tarball에는 `src/`가 없다. 그런데 0.85.1 manifest의 `./client`와
`./experimental/plugin`은 `source: ./src/...` 조건만 남아 있고 `files`는 해당 dist를
제외한다. 이 둘은 일반 Node npm 소비자가 사용할 export가 아니다. 0.84.2의 compiled
`./client` export를 그대로 기대하면 안 된다.

0.84.2와 직접 대조한 차이는 다음과 같다.

| surface | 0.84.2 | 0.85.1 |
|---|---|---|
| `bin.pi` | `dist/cli.js` | `dist/bundle/cli.js` |
| `./rpc-entry` | `dist/rpc-entry.js` | `dist/bundle/rpc-entry.js` |
| `./client` | compiled `types` + `import` | source condition만 존재, npm tarball에 source 없음 |
| client/protocol deps | runtime dependencies | devDependencies로 이동 |
| suite | agent-core/ai/tui | chord와 telemetry를 포함한 새 runtime graph |

이 차이는 `npm view @earendil-works/pi-coding-agent@{0.84.2,0.85.1}`과 실제
0.85.1 tarball을 함께 확인했다. changelog의 0.85.1 항목도 experimental code가
0.85.0 SDK import를 깨뜨려 source-only test 경로로 되돌렸다고 설명한다.

## Rubato가 좁게 연결하거나 패치해야 하는 경계

- 기존 load transforms는 `dist/core/**`, nested `pi-ai/dist/**`, `pi-tui/dist/**` 같은
  unbundled URL을 대상으로 한다. 0.85.1 stock CLI/RPC는 coding-agent, agent-core,
  pi-ai, pi-tui 코드를 `dist/bundle/chunks/**`에 넣었으므로 그 transform URL을 지나지
  않는다. staged runtime은 resolver의 `patchableCliEntry` / `patchableRpcEntry`를
  선택한다. bundle을 선택하려면 별도의 bundle 전용 patch와 검증이 필요하다.
- 공개 SDK root는 unbundled `dist/index.js`이므로 해당 SDK 경로의 내부 import에는
  좁은 file patch가 적용된다. 다만 SDK green은 bundled CLI green의 증거가 아니다.
- 현재 Rubato source/type/build external에는 `@code-yeongyu/senpi`가 남아 있고 RPC
  child resolver도 Senpi specifier를 직접 찾는다. 이 소비자는 stock package root/RPC
  entry로 전환해야 한다. 이 문서는 경로 계약만 정하며 해당 소비자 수정은 각 소유 영역이다.
- stock extension loader 자체는 `-e` extension과 suite alias를 제공하므로 새 범용
  extension framework는 필요 없다. Rubato extension bundle이 요구하는 alias 목록과
  stock loader 목록만 일치시켜야 한다.

## 아직 확인하지 않은 것

- 0.85.1 unbundled CLI/RPC에 기존 Rubato transform 전체를 적용했을 때의 drift와 행동 parity
- Rubato extension + task/team/subagent + provider/auth + session/reload/TUI의 결합 E2E
- staged runtime 설치/업데이트와 기존 세션 복사본 호환성
- bundle entry를 계속 사용할 경우 필요한 bundle 전용 patch 범위

따라서 이 문서와 resolver green은 “순정 0.85.1을 잘못된 package identity나 entry로
실행하지 않는다”는 증거다. 전체 Rubato parity나 기본 엔진 전환 완료 증거는 아니다.

## 이번 검증

```text
fresh root:  /private/tmp/rubato-pi-ci2.fxBU2P (검증 후 삭제)
empty cache: /private/tmp/rubato-pi-cache2.45eXVT (검증 후 삭제)
input:       package.json + package-lock.json만 복사
command:     env -u NODE_OPTIONS npm_config_cache=<empty-cache> npm ci --ignore-scripts --workspaces=false --prefix <fresh-root>
result:      260 packages added, 261 audited, 0 vulnerabilities
lock SHA-256 before/after:
             415010d7198091f391671e12cde4b71ecc5e6d62abd32f9e8d2003655d1c329b (동일)

lockfileVersion 3 package entries: 261 (root 1 + registry tarball 260)
registry tarball entries without integrity: 0
nested stock suite integrity: core/ai/tui/chord/telemetry 5/5
fresh install resolver identity: stock suite 6/6 at 0.85.1
fresh install cmd-shim identity: 8.0.0, runtime dependencies 0

stock bundled CLI --version:   0.85.1
stock unbundled CLI --version: 0.85.1
stock bundled RPC --version:   0.85.1
stock unbundled RPC --version: 0.85.1
public SDK import: VERSION 0.85.1, createAgentSession/discoverAndLoadExtensions 함수 확인

env -u NODE_OPTIONS npm --prefix harness/pi-runtime test
34 tests, 34 pass
```

중첩된 stock suite 다섯 tarball의 SHA-512 값은 각각 exact `0.85.1`에 대해 npm
registry가 반환한 `dist.integrity`와 대조했다. durable test는 lock의 version, registry
tarball URL, integrity를 고정하고, 설치된 공개 SDK와 bundled/unbundled CLI·RPC 네 entry가
모두 0.85.1인지 확인한다. 실행 때마다 비어 있는 임시 `PI_CODING_AGENT_DIR`를 쓰고
`NODE_OPTIONS`를 제거한다. npm registry 조회와 clean install 외의 network 또는 provider
API 요청은 실행하지 않았고, 기존 HOME profile, 전역 package, Senpi loader도 사용하지 않았다.

이 clean install은 package/lock 재현성과 stock entry identity의 증거다. 아직 Rubato
기능 parity나 staged runtime 전체 E2E의 증거는 아니다.

유지보수 주의: `npm install`은 coding-agent가 내장한 shrinkwrap을 다시 전개하면서 위
중첩 Pi 다섯 entry의 수동 보강 integrity를 제거한다. dependency 변경 후에는 다섯 값을
registry의 exact 0.85.1 `dist.integrity`로 다시 대조하고 이 테스트를 통과시켜야 한다.
최종 lock을 소비하는 `npm ci`는 이번 clean 검증에서 해당 값을 보존했다.
