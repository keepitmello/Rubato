# T3에 기능을 붙일 때

구조와 소유권은 [`T3_INTEGRATION.md`](T3_INTEGRATION.md)가 정본이다. 이 문서는 그 위에서
**무엇을 고칠 수 있고 무엇은 못 고치는지, 고친 것을 어떻게 확인하는지**만 다룬다.

## 하나뿐인 제약: 서버에서 끝나야 한다

사용자의 아이폰은 앱스토어에서 받은 T3 Code다. T3 클라이언트를 고쳐야 하는 기능은 그
폰에 영원히 닿지 않는다. 자체 빌드는 애플 서명이, 업스트림 기여는 T3의 방침이 막는다
(판단 근거는 기억 저장소 `decisions/t3-feature-work-is-server-side-only.md`).

반대로 우리 브릿지는 맥에서 도는 T3 서버 프로세스 **안**에 산다. 그래서 provider 스냅샷과
런타임 이벤트에 넣는 것은 앱을 한 줄도 고치지 않고 폰까지 간다.

```
[맥]  Rubato ─▶ 우리 브릿지 ─▶ T3 서버 ─┬─▶ 데스크톱 (apps/web 렌더러)
                                        └─▶ 아이폰 (앱스토어 빌드 그대로)
```

데스크톱 화면은 `apps/web`이다. 그래서 **웹에 있는 기능은 데스크톱에 있고, 모바일은 따로다.**

## 착수 순서: 소비자에서 거꾸로 읽는다

"T3가 이걸 그릴 수 있나"는 스키마가 아니라 **그리는 코드**가 답한다. 계약에 타입 이름이
있다고 표시되는 것이 아니다 — 추론 텍스트가 그 예다. `CanonicalItemType`에 `reasoning`이
있지만 저장 경로가 없어서 어느 프로바이더에서도 안 보인다.

1. 화면에서 그 값을 그리는 컴포넌트를 찾는다.
2. 그것이 읽는 상태를 거슬러 올라가 필요한 이벤트·필드를 확정한다.
3. **모바일과 웹을 따로 확인한다.** 둘은 다른 코드다. 모바일이 해당 활동을 `continue`로
   건너뛰거나(컨텍스트 미터) 컴포넌트 자체가 없을 수 있다.
4. 다른 어댑터가 이미 그 값을 보내고 있으면 그 파일을 읽는다. 기대하는 모양이 거기 있다.

**사용자 설정이 게이트인 경우가 있다.** T3는 일부 표면을 legacy로 분류해 기본으로 끈다.
데이터가 정확히 나가는데도 화면이 비면 `packages/contracts/src/settings.ts`의 기본값을 먼저
본다. 우리 기능이 걸린 값은 `harness/t3-integration/write-gui-settings.mjs`가 **한 번만**
심는다 — 매번 덮어쓰면 그건 설정이 아니라 강요고, 사용자는 그 파일을 신뢰하지 않게 된다.

## 무엇을 내보낼지 정하는 규칙

**상태를 바꾸는 명령은, 바꿨다고 T3에 알리는 것까지가 그 명령이다.** T3는 자기 사본을 보고
화면을 그린다. 뒤에서 바꾸면 화면이 거짓말을 하고, 사용자는 그런 일이 일어난 줄도 모른다.
없는 기능보다 나쁘다.

알릴 창구가 없으면 내보내지 않는다. 그래서 `/model`과 `/thinking`은 뺐고(`session.configured`를
듣는 쪽이 T3에 없다), `/fork`는 더 분명하게 뺐다(Pi만 되감으면 T3는 지운 메시지를 계속 든다).

같은 규칙이 숫자에도 걸린다. **정직하게 못 채우는 필드는 비운다.** 스키마가 대부분을 선택
항목으로 둔 이유가 그것이다. 추정치를 숫자 옷 입혀 보내면 사용자가 그걸 보고 판단한다.

다만 **비우는 것은 진짜 모를 때 쓴다.** 알아낼 방법이 있는데 안 알아본 자리에 쓰면, 이
규칙이 게으름을 덮는 핑계가 된다. 컨텍스트 창 크기가 그 예였다 — `get_state`가 재연결
직후 다른 계열의 기본 행을 답해서 272k가 나갔고, 처음 처방은 "모르면 비운다"였다. 그런데
카탈로그의 모든 모델 행에 `contextWindow`가 있고 브릿지는 그 카탈로그를 이미 캐시하고
있었다. 비울 자리가 아니라 **세션의 모델 id 로 찾을 자리**였다.

확장 명령의 `notify`도 이 규칙이다. Pi RPC는 그걸 대화로 두지 않고 `extension_ui_request`
이벤트(method `notify`, `notifyType` info/warning/error)로 흘린다. 호스트 `pendingUi`는
`select`/`confirm`/`input`/`editor`만 담으므로, 스냅샷 재적용이 아니라 **이벤트 투영**이
유일한 창구다. 여기서 빠지면 `/context-status`를 포함해 notify로 답하는 명령이 앱에서
전부 침묵한다.

T3 계약에는 `runtime.info`가 없다. `runtime.error`는 세션을 `error`로 바꾸고 행 제목을
"Runtime error"로 덮는다 — 명령이 사용자에게 답하는 것과는 다른 말이다. 세 톤 모두
`runtime.warning`으로 보낸다. ingestion이 이미 이 이벤트의 tone을 `info`로 두고 메시지를
행 제목으로 쓰기 때문이다. 웹은 `circle-alert`, 모바일은 `warning` 아이콘을 붙이는데, 그건
이벤트 종류의 칠이지 우리가 정보성 안내를 경고로 다시 이름 붙인 것이 아니다. info 전용
칸은 없다. 침묵보다 경고 톤의 보이는 안내가 낫다. 메시지는 확장이 보낸 그대로
`payload.message`에 두고, `detail`은 따로 온 것이 없으면 비운다.

`setStatus`는 TUI 바닥 상태줄이다. 키로 덮어쓰고 `undefined`로 지운다. T3에 그런 표면이
없고, 작업 로그 행으로 바꾸면 순간 표시가 영구 기록이 된다. 버린다.

## 모바일이 실제로 그리는 것은 좁다

계약의 구조화된 필드를 채우는 것이 옳지만, **모바일은 그중 일부만 그린다.** `model`,
`effort` 같은 linkage 필드는 웹(`subagentRuntime.ts`)이 쓰고 모바일은 import 조차 하지
않는다. 모바일 작업 로그가 그리는 것은 `title`과 상태 줄이다.

그래서 **폰에서 보여야 하는 값은 구조화된 칸에 넣는 것만으로 끝나지 않는다.** 칸에도 넣고
(웹이 쓴다), 짧은 형태로 텍스트에도 실어야 한다. 반대로 텍스트에 다 몰아넣으면 CLI
상태표시줄이 그대로 앱에 흘러나온다 — `$0.0000 · Speed 488` 같은 것. 줄의 주인공은 "지금
무엇을 하는 중"이고 메타데이터는 짧은 접두사다.

## 두 줄로 보이면 잇는 키를 먼저 본다

서브에이전트는 도구 호출 아이템과 태스크, 두 이벤트로 표현된다(다른 어댑터도 그렇다).
모바일은 **아이템의 tool call id 와 태스크의 `toolUseId` 가 같을 때만** 둘을 한 줄로 합친다.
함정은 그 id 의 출처다 — T3 ingestion 이 `itemId` 를 `payload.toolCallId` 로 복사하므로,
`data.toolCallId` 에 아무리 넣어도 이기지 못한다. 아이템 id 에 우리 네임스페이스를 붙이면
영영 안 맞는다.
## 확인하는 법

T3가 우리 이벤트를 전부 파일로 남긴다:

```
~/.rubato/t3-home/userdata/logs/provider/events.<threadId>.log
```

무엇을 보냈는지에 대한 1차 증거다. 종류별 집계로 시작하면 빠르다.

**함정: 이 로그는 transient 이벤트를 버린다.** `task.progress`와 `content.delta`는 기록되지
않는다(`EventNdjsonLogger`의 `transientCanonicalEventTypes`). **로그에 없다는 것이 안 보냈다는
증거가 아니다.** 실제로 이 착각으로 잘못된 원인을 브리프에 실은 적이 있다.

## 고친 것이 실제로 도는 자리 — 잔류 프로세스 셋

소스를 받거나 빌드해도 **이미 떠 있는 프로세스는 옛 코드로 계속 돈다.**

| 프로세스 | 무엇이 걸려 있나 | 재시작 |
|---|---|---|
| Pi 프로필 엔진 | `harness/pi-server/src/` | `rubato restart` (SIGTERM, `kill -9` 금지 — 락이 15초 stale로 남는다) |
| 데스크톱 앱 | `harness/t3-integration/src/` (켤 때 한 번 읽는다) | `rubato restart` |
| remote hub | `packages/rubato-remote-hub/` | `rubato restart` |

`rubato update`는 바뀐 경로를 보고 필요한 것만 재시작한다. 드라이버 오버레이
(`harness/t3-integration/overlay/`)를 고쳤으면 서버 번들을 다시 만들어야 하므로
`install-gui.sh --apply`까지 필요하다.

엔진 재시작은 진행 중이던 턴을 끊는다. 안전한 이유는 실측했다 — JSONL이 결과 없는 도구
호출로 끝나도 프로바이더 변환층이 합성 결과를 채워서 세션이 그대로 열린다. **다만 CLI
터미널은 스스로 다시 붙지 않는다.** T3는 붙는다(엔진이 `serverId`를 물려받는다).

## 이미 확인된 막다른 길

시간을 다시 쓰지 않도록 남긴다.

- **추론 텍스트 펼치기.** `ProviderRuntimeIngestion`이 `assistant_text`가 아닌 `content.delta`를
  전부 버리고, 아이템은 툴 생애주기 타입만 통과시킨다. 전 프로바이더 공통이고 화면의
  "Thinking"은 작업 중 표시등이다. 우리는 이미 보내고 있다 — 받는 쪽이 없다.
- **모바일의 메시지별 편집 버튼, 모바일 컨텍스트 미터.** 앱에 그 UI가 없다. 명령 표면
  (`/`)으로는 우회할 수 있다 — 폰도 타이핑하고 선택 카드를 그릴 수 있기 때문이다.
- **되감기에는 git 체크포인트가 전제다.** T3는 매 턴 `git add -A`로 스냅샷을 뜨는데, 인덱스를
  매번 새로 만들어 stat 캐시가 없어서 비용이 레포 전체 파일 수에 비례한다. 큰 미추적 폴더가
  있으면 30초 타임아웃을 넘겨 매 턴 실패하고, 체크포인트가 없으면 되감기 지점도 없다.
  증상은 `vcs process timed out` 한 줄뿐이라 연결이 잘 안 된다. 우리 산출물 폴더는
  `install.sh`가 전역 무시 목록에 심는다.

## 픽스처는 격리된 척만 하기 쉽다

`rubato-update.sh`의 시험 6개가 오래 빨간 채였고 "원래 실패한다"로 굳어 있었다. 원인은 GUI
감지가 `/Applications`를 절대 경로로 읽은 것 하나였다 — 픽스처 HOME·픽스처 git 설정·가짜
PATH를 다 만들어 놓고 그 한 줄이 진짜 시스템을 봤다. 이음매
(`RUBATO_APPLICATIONS_DIR`, `RUBATO_LAUNCHCTL_BIN`, `RUBATO_PGREP_BIN`, `RUBATO_GUI_PROC_PATTERN`)를
쓴다. **항상 빨간 시험은 시험이 아니다. 알려진 실패 여섯 개는 일곱 번째 진짜 실패가 숨는 자리다.**

프로세스를 찾는 패턴은 좁게 쓴다. `pgrep -f 'Rubato\.app'`은 `Contents/Frameworks` 밑 헬퍼까지
잡아서 창이 닫힌 뒤에도 살아 있는 것처럼 보이게 했고, 재실행이 조용히 건너뛰어졌다.

## 검증 명령

```sh
T3_SOURCE="$HOME/.rubato/t3-source" node --test --test-timeout=90000 harness/t3-integration/test/*.test.mjs
pnpm --dir "$HOME/.rubato/t3-source" --filter t3 typecheck
pnpm --dir "$HOME/.rubato/t3-source" --filter t3 build:bundle
```

시험은 실제 T3 계약·Effect·projector와 공식 Pi server/client를 쓴다. `T3_SOURCE` 없이 돌리면
드라이버 시험이 건너뛰어지므로, 오버레이를 고쳤으면 반드시 붙여서 돌린다.
