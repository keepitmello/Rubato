#!/bin/bash
# 맥 앱 번들을 이 머신에만 있는 로컬 서명 인증서로 서명한다.
#
# 애드혹 서명(--sign -)이면 macOS 는 앱을 바이너리 해시(cdhash)로 알아본다.
# `rubato update`·`rubato restart` 가 번들을 다시 만들 때마다 해시가 바뀌어서,
# 화면 기록·손쉬운 사용·전체 디스크 접근·자동화 권한이 옛 해시에 묶인 채
# 남았다. 시스템 설정에는 Rubato 가 켜져 있는데 실제 앱은 권한이 없는 상태다.
# 인증서로 서명하면 알아보는 기준이 "번들 id + 인증서"가 되어 다시 만들어도
# 권한이 따라온다.
#
# 인증서는 머신마다 한 번 만들고, 로그인 키체인이 아니라 전용 키체인에 둔다.
# 전용 키체인은 암호를 우리가 쥐고 있어서 codesign 이 개인키를 쓸 때 암호 창이
# 뜨지 않는다. 신뢰 목록에 올리지 않으니 이 인증서로 다른 것을 속일 수도 없다.
#
#   mac-signing.sh sign <bundle>   서명한다. 인증서가 없으면 만든다.
#   mac-signing.sh ensure          인증서만 만든다.
#
# 서명이 안 되면 애드혹으로 물러난다. 앱은 켜지되 권한은 예전처럼 빌드마다 풀린다.
# 알림은 stderr 로만 낸다 — install-macos-app.sh 의 stdout 은 번들 경로다.
set -euo pipefail

SIGN_DIR="${RUBATO_SIGNING_DIR:-$HOME/.rubato/signing}"
KEYCHAIN="$SIGN_DIR/rubato-signing.keychain-db"
PASS_FILE="$SIGN_DIR/keychain-password"
IDENTITY="Rubato Local Signing"
SECURITY="${RUBATO_SECURITY_BIN:-/usr/bin/security}"
CODESIGN="${RUBATO_CODESIGN_BIN:-/usr/bin/codesign}"
OPENSSL=/usr/bin/openssl

note() { printf 'mac-signing: %s\n' "$1" >&2; }

has_identity() {
  [ -f "$KEYCHAIN" ] && [ -f "$PASS_FILE" ] || return 1
  "$SECURITY" find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$IDENTITY\""
}

create_identity() (
  # 반쯤 만들어진 것은 지우고 처음부터 만든다. 남은 키체인 파일이 있으면
  # create-keychain 이 실패한다.
  rm -f "$KEYCHAIN" "$PASS_FILE"
  mkdir -p "$SIGN_DIR"
  chmod 700 "$SIGN_DIR"
  work="$(mktemp -d "${TMPDIR:-/tmp}/rubato-signing.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  pass="$("$OPENSSL" rand -hex 24)"
  cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$IDENTITY
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
  # 만료가 지나도 이미 준 권한은 유지되지만, 다시 만들면 인증서가 바뀌어 권한이
  # 풀린다. 그래서 길게 잡는다.
  "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$work/cert.cnf" \
    -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1
  "$OPENSSL" pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
    -name "$IDENTITY" -out "$work/id.p12" -passout "pass:$pass" >/dev/null 2>&1
  "$SECURITY" create-keychain -p "$pass" "$KEYCHAIN" >/dev/null
  # 시간이 지나도 스스로 잠그지 않게 한다. 재부팅 뒤 잠기는 것은 sign 이 푼다.
  "$SECURITY" set-keychain-settings "$KEYCHAIN" >/dev/null
  "$SECURITY" unlock-keychain -p "$pass" "$KEYCHAIN" >/dev/null
  "$SECURITY" import "$work/id.p12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign >/dev/null
  "$SECURITY" set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$KEYCHAIN" >/dev/null
  ( umask 077; printf '%s' "$pass" > "$PASS_FILE" )
  has_identity
)

ensure_identity() {
  has_identity && return 0
  note "이 머신용 로컬 서명 인증서를 만든다 ($KEYCHAIN)"
  create_identity
}

sign_adhoc() {
  "$CODESIGN" --force --deep --sign - --timestamp=none "$1" >/dev/null 2>&1 || true
}

sign_bundle() {
  local bundle="$1"
  if ensure_identity \
    && "$SECURITY" unlock-keychain -p "$(cat "$PASS_FILE")" "$KEYCHAIN" >/dev/null 2>&1 \
    && "$CODESIGN" --force --deep --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp=none "$bundle" >/dev/null 2>&1; then
    return 0
  fi
  note "로컬 인증서로 서명하지 못해 애드혹으로 서명한다. 다시 만들 때마다 macOS 권한이 풀린다."
  sign_adhoc "$bundle"
}

case "${1-}" in
  sign)
    [ -n "${2-}" ] && [ -d "$2" ] || { note "서명할 번들이 없다: ${2-}"; exit 1; }
    sign_bundle "$2"
    ;;
  ensure)
    ensure_identity
    ;;
  *)
    printf '사용법: %s sign <bundle> | ensure\n' "$0" >&2
    exit 64
    ;;
esac
