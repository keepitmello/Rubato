# Stock Pi media/web tool 이관 경계

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

결론: `webfetch`, `look_at`과 client `generate_image`를 runtime-owned feature로 옮겼다.
`generate_image`는 exact OpenAI SDK와 owned `openai-images` provider를 stock registry에
등록해 실제 local OpenAI-compatible endpoint까지 실행한다. OpenAI native image/search,
Anthropic native bash, `read_video`는 parser/catalog 차이가 있어 아래 미완료 경계에 남긴다.

## source와 배포 경계

- 기준 runtime: `@code-yeongyu/senpi@2026.9.4-3`
- npm integrity:
  `sha512-9crNMupK8ic5Qu7aCHPf3bDBu0jczo1Gv0eCxJNA1HTLi1RapwCzp7UMwYhXdSJsajeQSeGsZ5FTw9kuQOXoFw==`
- repository/tag: `https://github.com/code-yeongyu/senpi`, `v2026.9.4-3`, commit
  `b0a446488dafc813ec2ff56e515668c0fa990027`
- license: MIT, local `LICENSE` SHA-256
  `b572487f123bf259487f7dab25923af16fecd08ed7a2c50964f393282dba883c`
- provider source package: `@code-yeongyu/senpi-ai@2026.9.4-3`, npm integrity
  `sha512-ajUzHkmNvymthjTcQA8fyIWd8f4PgE5GdsgBlo2t+Ai6E2ddNyZTBe0pVwTqii6eMI6FbasWKqGkgz6L+T/eFg==`

공개 tag와 같은 exact npm 배포물의 compiled JS/source map을 함께 대조했다. `src/webfetch`
8개, `src/look-at` 9개, `src/imagegen` 5개와 skill asset, exact Senpi-AI OpenAI provider closure
8개를 소유한다. stock adapter/host/entry 5개와 LICENSE/notice를 합쳐 descriptor가
`rubato-features/media-tools/` 아래 file을 stage한다. 원래 Senpi package, global module,
HOME fallback은 없다.

webfetch의 exact direct dependencies는 다음과 같다.

| package | version | license | 역할 |
| --- | ---: | --- | --- |
| `undici` | 8.10.0 | MIT | bounded HTTP/redirect/abort |
| `jsdom` | 30.0.1 | MIT | HTML DOM과 readability 입력 |
| `@mozilla/readability` | 0.6.0 | Apache-2.0 | article 추출 |
| `turndown` | 7.2.4 | MIT | HTML → Markdown |
| `openai` | 6.26.0 | Apache-2.0 | `/v1/images/generations` client |

`jsdom@30.0.1`의 Node engine은 `^22.22.2 || ^24.15.0 || >=26.0.0`이다. 따라서 standalone
runtime이 기존 `>=24.11.0`을 유지하면 dependency 선언과 어긋나며 최소 24.x를 지원할 때는
`>=24.15.0`으로 맞춰야 한다. `typebox@1.3.18`은 이미 runtime root direct dependency다.

## 보존한 webfetch 계약

- `PI_WEBFETCH`는 기본 enabled이며 `0/false/no/off`만 disable한다.
- URL은 `http://`/`https://`만 허용하고 최대 20 redirect를 따라간다.
- browser-shaped headers, 기본 30초/최대 120초 timeout, download progress를 유지한다.
- `Content-Length`와 streaming body 모두 5MiB cap을 적용하고 abort 때 body를 파기한다.
- HTML은 요청 format에 따라 Readability + Turndown Markdown 또는 plain text로 변환한다.
- model에 돌려주는 text는 UTF-8 경계를 지키며 50KiB로 제한한다.
- session start/shutdown의 status/widget cleanup과 기존 TUI renderer를 보존한다.

## 보존한 look_at 계약과 좁은 stock adapter

- 단일/복수 local path, 현재 turn image attachment reference, raw/data-URL base64를 지원한다.
- remote URL 거부, image당 10MiB/합계 25MiB, MIME signature 및 settings의 image block/resize
  정책을 유지한다.
- session-only `/lookat` override, `lookAt.enabled`, ordered model chain, image-capable fallback과
  `:thinking` suffix를 유지한다.
- 현재 main model이 image input을 직접 받을 수 없고 별도 vision model이 available일 때만
  `look_at`을 active로 둔다.
- 분석 요청은 120초 timeout과 tool AbortSignal을 결합하고, provider error/abort/empty text를
  명시 오류로 바꾼다.

stock ExtensionContext에는 Senpi의 `getLookAtSettings`, `getImageSettings`가 없다. local
adapter는 bootstrap이 주입하는 shared `SettingsManager`에서 global/project `lookAt`과 stock
image settings를 같은 우선순위로 읽는다. Senpi가 직접 노출했던
`modelRegistry.modelRuntime.streamSimple(...).result()` 대신 stock 공개
`ModelRegistry.complete()`를 사용한다.

stock package root가 내보내지 않는 exact model-pattern helper는 look_at이 쓰는 subset만
local 보존했다. image normalize helper도 비공개 deep import 대신 stock 공개
`convertToPng`, `resizeImage`, `formatDimensionNote`를 합성한다. Pi AI의 `StringEnum`과 Pi TUI
renderer는 선택된 coding-agent가 실제 설치한 nested dependency identity를 따라가며 Senpi
alias를 허용하지 않는다.

## 보존한 client generate_image 계약과 provider adapter

- tool은 항상 등록하지만 image skill과 system prompt는 usable credential이 있을 때만 보탠다.
- credential 우선순위는 stored OpenAI key, `PI_IMAGE_GEN_PROVIDER`가 가리키는 gateway,
  OpenAI 이름을 우선한 deterministic gateway 순서, `OPENAI_API_KEY`다. seeded
  `SK-SENTINEL-DO-NOT-LOG-*` 값은 credential로 쓰지 않는다.
- model은 `gpt-image-2`이며 prompt 32,000자, 정해진 size/quality, `n=1..10` 계약을 유지한다.
- 기본 경로는 `generated-images/<sanitized tool call id>.png`다. 명시 경로는 cwd 기준이며
  extensionless path에는 `.png`를 붙이고, 여러 장은 zero-padded suffix를 사용한다.
- 기존 파일은 provider 요청 전에 거부한다. 파일은 `wx`로만 만들며 batch 중 하나라도 실패하면
  이번 호출이 앞서 만든 파일만 rollback한다.
- provider의 revised prompt, usage, image content를 보존하고 provider error/empty/abort를
  구조화된 실패 result로 돌려준다. native image tool이 활성화될 때 client call을 막는 seam도
  그대로 유지한다.

stock 0.85.1은 compat images registry에 `openrouter-images`만 기본 등록한다. runtime-owned
adapter는 exact Senpi-AI `openai-images` 구현을 stable source id로 등록한다. 이 provider는
base URL을 `/v1` root로 정규화하고 OpenAI/gateway credential header, interruptible retry,
provider body error, base64/data URL/HTTP image hydration과 24MiB cap/MIME 검사를 보존한다.

Senpi의 credential resolver가 직접 읽던 `authStorage`는 stock public API가 아니다. adapter는
stock `ModelRegistry.getProviderAuthStatus("openai").source === "stored"`로 같은 stored-key
분기를 식별하고, 실제 key/header는 계속 public `getProviderAuth()`와
`getApiKeyAndHeaders()`로 받는다. provider 실행은 `openai@6.26.0` exact dependency를 쓰며
유료 OpenAI endpoint를 test에서 호출하지 않는다.

## 로컬 실행 acceptance

`media-tools.test.mjs`는 빈 temporary cwd/agentDir와 loopback HTTP server, 가짜 vision
provider/model runner만 사용한다. 실제 stock SDK에 generic `executeTool`과 이 feature를 stage한
뒤 다음을 확인하도록 구성했다.

1. stage receipt와 다섯 direct dependency exact version, `PI_WEBFETCH=off` gate
2. `webfetch` redirect → HTML article Markdown, progress 3단계, noise 제거
3. invalid scheme, oversized Content-Length의 bounded error result
4. in-flight AbortSignal 뒤 response socket close와 test server의 전체 socket cleanup
5. local PNG `look_at`, configured vision chain과 `low` reasoning, stock completion request shape
6. text model에서는 active, image model에서는 inactive인 tool routing
7. remote path 거부, provider error/empty response, in-flight vision completion abort
8. stored/pinned/sorted/env image credential 우선순위와 sentinel 배제
9. actual `/v1/images/generations` request의 model/prompt/size/quality/n/header 및 usage/revised prompt
10. 2장 PNG `wx` write, existing-file preflight, provider error, in-flight abort/socket close,
    partial-write rollback과 native bypass

provider network, user profile, 유료 모델은 호출하지 않는다. 다음처럼 standalone의 실제
stock SDK 설치본에서 실행했다.

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE \
  node --test --test-timeout=300000 \
  harness/pi-runtime/features/media-tools/media-tools.test.mjs
```

standalone 전체 copy/stage를 포함하므로 300초는 느린 filesystem을 위한 bounded headroom이며
provider timeout을 늘린 것이 아니다. native clone stager가 반영된 최근 전체 실행은 4 test
모두 pass, fail/skip 0, 약 46.6초였다. 이 중 actual staged SDK integration은 약 41.5초였다.

## A5

9/8 wip 이후 runtime-owned closure는 43개다. 문서의 38은 webfetch 8 + look-at 9 +
imagegen 5(+skill) + openai-images 8 + adapter/host/entry 5 + LICENSE/notice 기준이고,
현재 `src/index.mjs`가 추가로 native `openai-image-gen` 4파일과 `openai-web-search`
1파일을 등록한다. 이 다섯은 stray가 아니라 같은 feature의 native 경로다. parser
parity는 아래 미완료 표에 남는다.

## 별도 미완료 contract

| family | source상 현재 계약 | stock 0.85.1 blocker |
| --- | --- | --- |
| `openai-image-gen` | official OpenAI Responses에서 native tool, 그 외 client fallback; 결과를 file로 externalize하고 base64 scrub | stock Responses parser가 `image_generation_call`/`providerNative`를 만들지 않아 반환 image bytes를 버린다. extension만 복사하면 안 된다. |
| `anthropic-bash` | `PI_ANTHROPIC_BASH` default-off, Anthropic payload에 `bash_20250124` 삽입 | stock Anthropic parser에 `server_tool_use`/native result 처리가 없다. request 주입만 통과해도 실행 parity가 아니다. |
| `openai-web-search` | `PI_OPENAI_WEB_SEARCH` default-on, supported Responses payload에 `web_search_preview`/source include 삽입 | payload hook은 공개 API로 가능하지만 native output/renderer end-to-end는 아직 검증하지 않았다. |
| `read_video` | local video regular file, extension/MIME, nonempty/100MiB, pre/post-read abort, model capability activation | stock `Model.input` 타입과 bundled catalog에 `video`가 없고 Senpi Kimi k3의 `text,image,video` metadata도 없다. |

client imagegen은 stock compat registry의 stable source id와 owned `openai-images` closure로
닫았다. native image와 native Anthropic bash는 각각 provider parser 변경까지 필요하므로 이
단위에서 client 경로로 가장하거나 payload 주입만 하고 완료 처리하지 않는다.
