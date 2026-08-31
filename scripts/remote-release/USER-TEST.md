# Rubato Remote 직접 테스트

이 문서는 개발자가 아닌 사용자도 Mac 한 대와 iPhone 한 대에서 Rubato Remote를
설치하고 핵심 기능을 확인할 수 있게 만든 순서표다. 기본 확인은 약 20분 걸린다.

## 먼저 준비할 것

- Mac과 iPhone에 Tailscale을 설치하고 **같은 tailnet 계정**으로 로그인한다.
- Mac에는 Node 24 이상과 **Bun 1.4.0**을 설치한다.
- Mac의 Rubato에서 평소 쓰는 provider 로그인이 이미 동작해야 한다.
- Tailscale Funnel은 켜지 않는다. Rubato는 tailnet 안의 Serve만 사용한다.
- 공식 릴리스를 시험한다면 압축을 푼 release 디렉터리와 `release-public.pem`을 준비한다.

Mac 터미널에서 버전과 Tailscale 연결부터 확인한다.

```bash
node --version
bun --version
tailscale status
```

`bun --version`은 `1.4.0`이어야 하고 `tailscale status`에는 이 Mac과 iPhone이
둘 다 보여야 한다.

## 1. 설치하기

저장소 루트에서 실행한다. 공식 릴리스와 현재 checkout의 개발용 빌드 중 하나만
선택하면 된다.

### 공식 릴리스가 있을 때

```bash
export RELEASE_DIR="/path/to/unpacked-rubato-remote-release"
export RELEASE_PUBLIC_KEY="/path/to/release-public.pem"

scripts/remote-release/verify.sh \
  --release "$RELEASE_DIR" \
  --public-key "$RELEASE_PUBLIC_KEY"

scripts/remote-release/install.sh \
  --release "$RELEASE_DIR" \
  --public-key "$RELEASE_PUBLIC_KEY"
```

### 현재 checkout을 직접 시험할 때

이 경로는 로컬에서 만든 unsigned 개발 빌드임을 명시하는
`--trusted-local-build`를 사용한다. 배포용 파일을 만드는 경로는 아니다.
Zig 0.16.0이 필요하고 zmx를 처음 빌드할 때는 몇 분 걸릴 수 있다.

먼저 `git status --short`가 비어 있는 clean checkout인지 확인한다.

```bash
ARCH=darwin-arm64
[ "$(uname -m)" = "x86_64" ] && ARCH=darwin-x64

rm -rf /tmp/rubato-zmx-local /tmp/rubato-remote-local

node scripts/remote-release/build-zmx-release.mjs \
  --output /tmp/rubato-zmx-local \
  --platform "$ARCH"

node scripts/remote-release/build-release.mjs \
  --output /tmp/rubato-remote-local \
  --zmx-asset "/tmp/rubato-zmx-local/zmx-$ARCH" \
  --build-id "manual-$(git rev-parse --short HEAD)-$(uname -m)"

scripts/remote-release/verify.sh \
  --release /tmp/rubato-remote-local \
  --trusted-local-build

scripts/remote-release/install.sh \
  --release /tmp/rubato-remote-local \
  --trusted-local-build
```

설치 중 `Serve is not enabled on your tailnet`이 나오면 오류에 함께 나온 Tailscale
관리자 링크를 열어 **Serve만 활성화**하고 설치 명령을 다시 실행한다. Funnel은
활성화하지 않는다. 설치가 성공하면 HTTPS 주소와
`~/Library/Application Support/Rubato/remote/pair/rubato-remote-qr.png`가 생긴다.

## 2. Mac 상태 확인하기

```bash
rubato remote doctor
```

출력의 `ok`가 `true`이고 `summary.failed`가 `0`이면 된다. `push-profile`이나 오래된
후보 파일처럼 선택 기능은 `warn`일 수 있다.

새 iPhone을 연결할 일회용 정보를 만든다.

```bash
rubato remote add-host
```

첫 줄에 나온 `https://…/rubato/?pair=…` 주소를 iPhone Safari에서 연다. 주소와
연결 코드는 10분 동안 한 번만 사용할 수 있다.

## 3. iPhone에 설치하기

1. Safari에서 연결 주소를 연다.
2. Mac 이름과 Tailscale 계정이 맞는지 확인하고 **이 Mac 연결**을 누른다.
3. Safari 공유 버튼에서 **홈 화면에 추가**를 누른다.
4. Safari 탭을 닫고 홈 화면의 Rubato 아이콘으로 다시 연다.

홈 화면 앱에서 Mac 이름이 보이고 연결 상태가 온라인이면 설치 확인은 끝이다.

## 4. 기본 동작 확인하기

아래 항목은 위에서부터 차례대로 확인한다.

- [ ] **새 세션**을 누르고 Mac, 작업 폴더, 모델을 고른 뒤 **세션 시작**을 누른다.
- [ ] `현재 폴더 이름과 파일 세 개만 알려줘`를 보내고 답이 실시간으로 나타나는지 본다.
- [ ] 답을 만드는 동안 `첫 답이 끝나면 한 줄로 요약해줘`를 입력하고
      **다음 차례**로 보내 순서대로 실행되는지 본다.
- [ ] `＋` → **이미지 추가**로 사진 한 장을 보내고 이미지 내용을 물어본다.
- [ ] `•••` → **스킬과 명령**에 현재 세션에서 실행 가능한 명령만 보이는지 확인한다.
- [ ] `•••` → **파일과 변경점**에서 변경점, 파일, 이미지 탭을 열어 본다.
- [ ] 작업 중 홈 화면으로 나갔다가 30초 뒤 돌아와 대화가 중복되거나 빠지지 않았는지 본다.

이 단계가 모두 되면 메시지 전송, 순서 보존, 재연결, 이미지, 명령 목록과 artifact
표시가 한 번에 확인된다.

## 5. 비상 터미널 확인하기

세션 화면에서 `•••` → **비상 터미널**을 열고 다음 한 줄을 입력한다.

```bash
printf 'rubato-terminal-ok\n'
```

`rubato-terminal-ok`가 보이면 된다. 이어서 `↑`, `↓`, `Tab`, **붙여넣기**와
스크롤을 한 번씩 확인하고 **터미널 닫기**를 누른다. 비상 터미널은 일반 대화로
처리할 수 없는 명령에만 쓰는 탈출구다.

## 6. 알림 확인하기

iOS Web Push는 iOS 16.4 이상에서 홈 화면에 추가한 PWA로 시험한다.

1. Rubato의 **설정** → **작업 알림** → **알림 켜기**를 누르고 iOS 권한을 허용한다.
2. 새 세션에서 테스트나 빌드처럼 1분 정도 걸리는 작업을 시작한다.
3. Rubato를 백그라운드로 보내고 화면을 잠근다.
4. 작업 완료 또는 사용자 확인 요청 알림이 오는지 본다.
5. 알림을 눌렀을 때 해당 Mac과 세션으로 돌아오는지 본다.

알림이 오지 않으면 **구독 새로 등록**을 한 번 누르고 다시 시험한다.

## 7. 네트워크 복구 확인하기

1. 답을 생성하는 동안 iPhone Wi-Fi를 끄고 셀룰러로 바꾼다.
2. 10초 정도 기다린 뒤 Rubato를 다시 연다.
3. 온라인으로 돌아오고 대화가 중복되거나 빠지지 않았는지 확인한다.
4. Wi-Fi를 다시 켜고 같은 확인을 한 번 더 한다.

Mac과 iPhone이 어느 네트워크에 있든 둘 다 같은 tailnet에 온라인이어야 한다.

## 선택: 두 번째 Mac 확인하기

두 번째 Mac에도 같은 설치를 하고 그 Mac에서 `rubato remote add-host`를 실행한다.
iPhone의 **설정** → **Mac 연결**에서 추가하면 홈 화면에 Mac별 세션이 나뉘어야 한다.
**Mac 간 프로필 동기화**를 누르면 같은 알림 구독을 두 Mac에서 사용할 수 있어야 한다.

## 문제가 생기면

| 증상 | 먼저 할 일 |
|---|---|
| `Serve is not enabled` | 오류에 나온 Tailscale 관리자 링크에서 Serve만 켜고 설치를 다시 실행한다. |
| `rubato remote doctor`가 실패함 | 출력에서 `status: "fail"`인 첫 항목을 확인한다. Tailscale 로그인 계정이 설치 당시 계정과 같은지도 본다. |
| iPhone에서 Mac이 안 보임 | `rubato remote add-host`를 다시 실행해 새 10분짜리 주소를 만든다. |
| 홈 화면 앱이 오프라인임 | Mac의 Tailscale과 iPhone의 Tailscale이 모두 Connected인지 확인한다. |
| 알림 권한이 안 보임 | Safari 탭이 아니라 홈 화면에 추가한 Rubato 앱에서 다시 연다. |
| 삭제가 Tailscale 오류로 멈춤 | Serve 경로를 남기지 않기 위한 보호다. Tailscale에 다시 로그인한 뒤 삭제를 재시도한다. |

## 테스트 뒤 삭제하기

먼저 iPhone **설정**에서 **알림 끄기**와 **연결 해제**를 누른다. 그다음 Mac에서
실행한다.

```bash
rubato remote uninstall --yes --remove-push
```

실행 중인 세션이 있으면 기본적으로 삭제를 멈춘다. 세션을 종료하고 다시 실행하는 쪽이
안전하다. transcript, journal, snapshot, artifact와 audit log는 기본적으로 보존된다.
