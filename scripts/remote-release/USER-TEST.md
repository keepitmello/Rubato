# Rubato Remote 호스트 확인

아이폰 클라이언트는 T3 Code다. 맥에서 `rubato-gui`로 연 환경에 T3 Connect로 붙인다.
이 문서는 Mac 쪽 허브 설치와 `doctor`만 다룬다.

## 먼저 준비할 것

- Mac에 Tailscale을 설치하고 로그인한다.
- Mac에는 Node 24 이상과 **Bun 1.4.0**을 설치한다.
- Mac의 Rubato에서 평소 쓰는 provider 로그인이 이미 동작해야 한다.
- Tailscale Funnel은 켜지 않는다.
- 공식 릴리스를 시험한다면 압축을 푼 release 디렉터리와 `release-public.pem`을 준비한다.

Mac 터미널에서 버전과 Tailscale 연결부터 확인한다.

```bash
node --version
bun --version
tailscale status
```

`bun --version`은 `1.4.0`이어야 한다.

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

설치는 LaunchAgent로 허브를 올리고 소켓 `cli.health`가 응답할 때까지 기다린다.
Tailscale Serve `/rubato` 경로는 더 이상 만들지 않는다.

## 2. Mac 상태 확인하기

```bash
rubato remote doctor
```

출력의 `ok`가 `true`이고 `summary.failed`가 `0`이면 된다. `tailscale-serve`는
예전에 남아 있는 `/rubato` 경로가 있으면 경고이고, 없으면 통과다.

허브 소켓 쪽 확인은 `unix-socket`과 `localhost-health`다. 후자는 HTTP가 아니라
허브 소켓의 `cli.health`다.

## 문제가 생기면

| 증상 | 먼저 할 일 |
|---|---|
| `rubato remote doctor`가 실패함 | 출력에서 `status: "fail"`인 첫 항목을 확인한다. Tailscale 로그인 계정이 설치 당시 계정과 같은지도 본다. |
| `tailscale-serve`가 warn | 예전 `/rubato` Serve 경로가 남아 있다. 삭제를 한 번 돌리면 지워진다. |
| 삭제가 Tailscale 오류로 멈춤 | 남은 Serve 경로를 지우기 위한 보호다. Tailscale에 다시 로그인한 뒤 삭제를 재시도한다. |

## 테스트 뒤 삭제하기

```bash
rubato remote uninstall --yes --remove-push
```

실행 중인 세션이 있으면 기본적으로 삭제를 멈춘다. 세션을 종료하고 다시 실행하는 쪽이
안전하다. transcript, journal, snapshot, artifact와 audit log는 기본적으로 보존된다.
