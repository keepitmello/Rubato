# Rubato 사용 가이드

Rubato를 설치하고 매일 운영할 때 필요한 내용만 정리한다.

엔진은 **stock pi 하나**다 (`@earendil-works/pi-coding-agent`). 어댑터와 버전 핀은
`harness/pi-runtime`이 갖는다.

## 설치

요구 사항은 Node 24+와 bun 1.4+다.

```bash
git clone --branch rubato/base https://github.com/keepitmello/Rubato.git
cd Rubato
./install.sh          # 설치 계획 확인
./install.sh --apply  # 실제 설치
```

공식 GUI는 T3 Code다. `./install.sh --apply --gui` 또는 적용 때 묻는 선택으로
설치하고, 화면 제공자 이름은 Rubato다. 터미널 실행기는 **Rubato CLI** (`rubato`)다.

맥에서는 에이전트가 돌리는 도구(screencapture, Peekaboo, osascript)가 Rubato 앱의
권한을 빌려 쓴다. 설정 → **macOS 권한**에서 화면 기록·손쉬운 사용·전체 디스크
접근·자동화를 보고 요청한다. 앱은 머신마다 한 번 만드는 로컬 인증서
(`~/.rubato/signing/`, `t3-integration/mac-signing.sh`)로 서명되므로
`rubato update`·`rubato restart`가 앱을 다시 만들어도 준 권한이 유지된다.

설치가 끝나면 새 셸을 열거나 안내된 rc 파일을 다시 읽는다.

```bash
rubato auth
rubato
```

credential은 저장소에 복사하지 않는다. `rubato auth`가 연결 상태를 보여 주고,
TTY에서는 **방향키만으로** 프로바이더와 계정을 다룬다 — ↑↓ 이동, Enter 선택,
Esc 뒤로, q 종료. 명령어를 칠 일은 API 키와 setup-token 붙여넣기뿐이다.

상태는 `연결됨` / `재로그인 필요` / `차단됨` / `로그인 필요` 넷이고, 액세스 토큰
카운트다운은 보여 주지 않는다 — 런타임이 쓰기 직전에 갱신하므로 그 숫자로는 아무
판단도 못 한다. 대신 `credential-pool-state.json`에 남은 실제 거부 기록을 반영하고,
정말 살아 있는지는 계정 메뉴의 `연결 확인`이 갱신을 한 번 돌려서 답한다. 성공하면
차단 기록도 푼다.

스크립트용 비대화 형태(`rubato auth login <provider> [oauth|token|key]`,
`list`/`pin`/`unpin`/`remove`)는 그대로 남는다.

## 실행

```bash
rubato       # Rubato CLI
rubato-pi    # Rubato CLI와 같은 실행기 (내부 이름)
rubato-gui   # 공식 GUI (T3)
rubato-soul  # 역할별 프롬프트 없이 SOUL.md만 사용
rubato dispatch <name> [별칭] < brief.md
             # 비대화 워커. 브리프는 stdin, 끝나면 최종 답만 stdout.
             # PATH의 `dispatch`도 같은 명령이다. 별칭·모델은 `dispatch --help`.
rubato aside-cursor --install  # Aside Cursor 면. 설명은 aside-cursor.md
```

Rubato는 작업을 리드, 독립 작업자, 검증자로 나누고 각 작업에 맞는 모델을 선택한다.
대화에는 다음 행동을 바꾸는 근거만 남기고, 오래 쓸 정보는 기억 저장소로 분리한다.

## 기억 검색

`msearch`는 프로젝트별 기억을 검색한다.

```bash
msearch "검색어"     # 현재 프로젝트
msearch -a "검색어"  # 모든 프로젝트
msearch --doctor     # 저장소와 검색 인덱스 상태 확인
```

검색 인덱스가 멈춰도 기억 파일은 그대로 남는다. `msearch --doctor`의 안내에 따라
인덱스를 다시 만들면 된다.

## 상주 기억

`~/.rubato/memory/self/repo/` 의 `user.md`(사람에 대한 오래가는 사실과 선호)와 `soul.md`(사용자가 덧붙이는
에이전트 성격)는 세션이 시작할 때 통째로 시스템 프롬프트에 실린다. 세션 중에 고쳐도 그 세션에는
반영되지 않고 다음 세션부터 실린다 — 캐시 접두를 깨지 않기 위해서다. 비어 있으면 아무것도 싣지 않는다.

## 꿈 — 기억 정리

기억 저장소는 프로젝트 `.rubato/rubato.jsonc` 의 `memory.agent` 로 이름을 붙인 폴더에만 있다.
이름이 없는 폴더에서는 memory 도구가 기억이 꺼져 있다고 답하고 저장소를 만들지 않는다.
꿈은 켠 저장소마다 그 폴더에서 열린 세션(사용자 말과 턴마다 마지막 답)과 그사이 커밋을 읽고,
"왜"만 현재 답으로 고치고 코드와 어긋난 결론을 바로잡는다. 결과는 브랜치로 기다린다.

```bash
rubato dream                  # 저장소별 켜짐·마지막 실행·새 세션·검토 대기
rubato dream --due            # 켠 저장소 중 때가 된 것만 실행
rubato dream <저장소>          # 지금 실행
rubato dream --approve <저장소> # 기다리는 결과를 저장소에 넣기 (--reject 는 버리기)
```

켜기·모델·발행 방식은 `~/.rubato/rubato.jsonc` 의 `memory.dream`(`stores.<이름>.enabled`,
`category`, `publish: "review" | "auto"`, `min_hours_between`)이다. 실행 기록은 저장소의 `runtime/dream/runs/` 에 남는다.
사람이 쓰는 세션(TUI·GUI)은 시작과 끝에 `rubato dream --due` 를 백그라운드로 띄운다. 때가 된 저장소가
없으면 바로 끝나고, 출력은 `~/.rubato/memory/dream-due.log` 에 남는다.

## 업데이트

```bash
rubato update --check # 업데이트 유무만 확인
rubato update         # 변경 내용 확인 후 적용
```

업데이트는 dirty worktree를 덮어쓰지 않는다. 로컬 변경이 있으면 먼저 커밋하거나 별도로
보관한 뒤 다시 실행한다. 의존성, 프롬프트, 확장, 엔진 중 바뀐 부분만 다시 설치하거나 빌드한다.

맥 데스크톱 앱을 쓰면 터미널을 열지 않아도 된다. 앱이 주기적으로 새 커밋을 확인해
화면 안 다이얼로그로 알리고, 업데이트를 누르면 **앱 밖 일회성 작업**이 기존 업데이트를
실행한다. 앱이 꺼져도 그 작업은 살아서 앱을 다시 열고, 새 창이 실제로 뜬 것을 확인한
뒤 스스로 정리한다. 실패하면 앱 안에서 오류 기록을 볼 수 있다.

이 경로는 충돌 해결을 대신하지 않는다. 로컬 수정이나 갈라진 커밋이 있으면 작업은
그것을 치우지 않고 멈춘다 — 그때는 `rubato update` 로 직접 해결한다. macOS 데스크톱
앱에서만 도는 경로이고, Windows·웹·모바일은 위의 명령을 그대로 쓴다.

성공한 업데이트 뒤에는 가명 속도 수집을 백그라운드에서 확인한다. 기존 `gh` 로그인에
전용 비공개 저장소 쓰기 권한이 있는 참여 기기만 전송하며, 본문은 보내지 않는다.
`--check`는 전송하지 않고, 수집 실패도 업데이트를 막지 않는다.
수집 범위와 끄는 방법은 [Speed 데이터 수집](rubato-pi/docs/speed-data.md)을 따른다.

## 다시 시작

```bash
rubato restart        # 도는 것을 새 코드로 올린다
```

프로필 엔진·remote hub·데스크톱 앱을 그 순서로 내리고 올린다. 앱은 quit 요청으로만 내리고
(내장 T3 서버가 SQLite를 들고 있다), 내려가 있는 동안 핀과 overlay로 서버 번들을 다시
만든다 — 그 창이 유일한 자리다. 이미 핀에 맞으면 빌드 없이 지나간다. 앱이 꺼져 있으면
번들만 맞추고 켜지는 않는다. 없는 것은 조용히 건너뛰므로 GUI가 없는 머신에서도 그대로 쓴다.

**손으로 칠 일은 `rubato update` 와 `rubato restart` 뿐이다.** 원격에서 받아 반영하는 쪽이
`update`, 받지 않고 도는 것만 새 코드로 올리는 쪽이 `restart`다. 앱을 끄고·다시 만들고·켜는
일은 `t3-integration/restart-gui.sh` 하나가 쥐고 있고 두 동사가 같이 부르므로, 어느 쪽을
쳐도 앱까지 간다. 설치 스크립트를 직접 찾아 칠 일은 없다.

## 다시 빌드

```bash
rubato build
```

프롬프트 조각이나 엔진 소스를 직접 수정한 경우에만 사용한다. 일반 설치와 업데이트는 필요한
빌드를 자동으로 수행한다.

## 문제 해결

1. `rubato auth`로 연결 상태를 확인하고 필요한 계정을 추가한다.
2. `msearch --doctor`로 기억 검색 상태를 확인한다.
3. `rubato build`로 엔진과 프롬프트를 다시 만든다.
4. 그래도 실패하면 현재 commit, 실행한 명령, 첫 오류 메시지를 함께 이슈에 남긴다.

저장소: <https://github.com/keepitmello/Rubato>
