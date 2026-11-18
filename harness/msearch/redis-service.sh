#!/usr/bin/env bash
# msearch 의 검색 백엔드(Redis + Search 모듈)를 6380 에 세우고 로그인 때마다 뜨게 한다.
# ./install.sh --apply 가 부르고, 손으로 불러도 된다. 기본은 계획만 말한다.
#
#   redis-service.sh            지금 상태와 할 일을 말한다
#   redis-service.sh --apply    없으면 깔고, 죽어 있으면 고쳐서 띄운다
#   redis-service.sh --check    떠 있으면 0, 아니면 1 (앱 설정 화면이 수 초마다 묻는다)
#
# 버전과 cask 고정 커밋은 runtime.lock 이 정본이다. 6380 에 맞는 서버가 이미 떠
# 있으면 손대지 않는다. 같은 포트를 쓰는 launchd 작업이 이미 있으면(예전 손설치)
# 새로 만들지 않고 그것을 되살린다. macOS + Homebrew 만 다룬다.
set -u
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
LOCK="$HERE/runtime.lock"
lock() { awk -F= -v key="$1" '$1 == key { print $2 }' "$LOCK"; }
REDIS_VERSION="$(lock REDIS_VERSION)"
SEARCH_VERSION="$(lock SEARCH_VERSION)"
CASK_COMMIT="$(lock REDIS_CASK_COMMIT)"
# 포트와 작업 이름은 시험이 실제 서버를 건드리지 않고 이 경로를 돌릴 때만 바꾼다.
PORT="${MSEARCH_REDIS_PORT:-6380}"
LABEL="${MSEARCH_REDIS_LABEL:-com.keepitmello.rubato.msearch-redis}"
AGENTS="$HOME/Library/LaunchAgents"
DATA="$HOME/.rubato/msearch/redis"
APPLY=0
CHECK=0
[ "${1-}" = "--apply" ] && APPLY=1
[ "${1-}" = "--check" ] && CHECK=1

say()  { printf '  %s\n' "$1"; }
fail() { printf '  ! %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "macOS 만 자동으로 세운다. 다른 OS 는 harness/msearch/README.md 의 Redis 절을 따른다"
# brew --prefix 는 느려서(수백 ms) 자주 묻는 --check 에 맞지 않는다. 두 표준 자리를 본다.
BREW_PREFIX=""
# 시험만 MSEARCH_BREW_PREFIX 로 가짜 Homebrew 를 가리킨다.
for prefix in ${MSEARCH_BREW_PREFIX:-/opt/homebrew /usr/local}; do [ -x "$prefix/bin/brew" ] && { BREW_PREFIX="$prefix"; break; }; done
CASK_DIR="${BREW_PREFIX:-/opt/homebrew}/Caskroom/redis/$REDIS_VERSION"
SERVER="$CASK_DIR/bin/redis-server"
CLI="$CASK_DIR/bin/redis-cli"
MODULES="$CASK_DIR/lib/redis/modules"

# 6380 의 서버가 runtime.lock 의 Redis 와 Search 를 그대로 싣고 있는가.
healthy() {
  [ -x "$CLI" ] || return 1
  "$CLI" -p "$PORT" ping >/dev/null 2>&1 || return 1
  "$CLI" -p "$PORT" INFO server 2>/dev/null | grep -q "^redis_version:$REDIS_VERSION" || return 1
  "$CLI" -p "$PORT" INFO modules 2>/dev/null | grep -q "^search_version:$SEARCH_VERSION"
}

if [ "$CHECK" -eq 1 ]; then healthy; exit $?; fi
if healthy; then
  say "Redis $REDIS_VERSION + Search $SEARCH_VERSION 이 이미 $PORT 에 떠 있다"
  exit 0
fi
[ -n "$BREW_PREFIX" ] || fail "Homebrew 가 없다. https://brew.sh 를 깐 뒤 다시 실행한다"
PATH="$BREW_PREFIX/bin:$PATH"

# 이 포트로 redis 를 띄우는 launchd 작업. 예전에 손으로 건 것도 그대로 쓴다.
existing_plist() {
  local file
  for file in "$AGENTS"/*.plist; do
    [ -f "$file" ] || continue
    grep -q 'redis-server' "$file" && grep -q "<string>$PORT</string>" "$file" && { printf '%s\n' "$file"; return 0; }
  done
  return 1
}
PLIST="$(existing_plist || true)"

# 깔린 서버와 모듈이 실제로 링크하는 Homebrew 라이브러리 중 없는 것의 formula 이름.
# tap 의 지금 cask 는 의존성 목록이 바뀌어 깔린 판과 어긋난다 — 8.4.0 Search 모듈은
# llvm@18 의 libunwind 를 링크하는데 tap 은 더 이상 llvm@18 을 적지 않았고, brew 정리로
# 그것이 빠지자 Redis 가 모듈을 싣다 죽고 launchd 는 이틀 동안 재시작만 했다(2026-11-16).
missing_linked() {
  local file path
  for file in "$SERVER" "$MODULES/redisearch.so" "$MODULES/rejson.so"; do
    [ -e "$file" ] || continue
    otool -L "$file" 2>/dev/null | awk 'NR > 1 { print $1 }' | while read -r path; do
      case "$path" in "$BREW_PREFIX"/opt/*) [ -e "$path" ] || printf '%s\n' "$path" ;; esac
    done
  done | sed "s|^$BREW_PREFIX/opt/\([^/]*\)/.*|\1|" | sort -u
}
MISSING="$(missing_linked | tr '\n' ' ')"
MISSING="${MISSING% }"

if [ "$APPLY" -eq 0 ]; then
  [ -x "$SERVER" ] || say "[계획] redis/redis tap 의 $REDIS_VERSION cask 를 고정 커밋 ${CASK_COMMIT:0:12} 에서 깐다"
  [ -n "$MISSING" ] && say "[계획] 빠진 라이브러리의 formula 를 깐다: $MISSING"
  if [ -n "$PLIST" ]; then say "[계획] 기존 launchd 작업 $(basename "$PLIST" .plist) 을 다시 띄운다"
  else say "[계획] launchd 작업 $LABEL 을 만들어 로그인 때 $PORT 에 뜨게 한다 (데이터 $DATA)"; fi
  exit 0
fi

if [ ! -x "$SERVER" ]; then
  say "redis $REDIS_VERSION cask 를 깐다"
  brew tap redis/redis >/dev/null || fail "brew tap redis/redis 실패"
  TAP="$(brew --repo redis/redis)"
  ORIGINAL="$(git -C "$TAP" rev-parse --abbrev-ref HEAD)"
  git -C "$TAP" fetch -q origin "$CASK_COMMIT" 2>/dev/null || true
  git -C "$TAP" checkout -q "$CASK_COMMIT" || fail "tap 을 고정 커밋으로 못 돌렸다"
  brew trust --cask redis/redis/redis >/dev/null 2>&1 || true
  HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask redis/redis/redis
  installed=$?
  git -C "$TAP" checkout -q "$ORIGINAL" || true
  [ "$installed" -eq 0 ] && [ -x "$SERVER" ] || fail "redis $REDIS_VERSION cask 설치 실패"
fi

# 방금 cask 를 깔았으면 링크 대상도 그 뒤에 다시 본다.
MISSING="$(missing_linked | tr '\n' ' ')"
for dep in $MISSING; do
  say "빠진 라이브러리의 formula $dep 을 깐다"
  HOMEBREW_NO_AUTO_UPDATE=1 brew install "$dep" >/dev/null || fail "$dep 설치 실패"
done

if [ -n "$PLIST" ]; then
  JOB="$(basename "$PLIST" .plist)"
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/$JOB" || fail "$JOB 을 다시 못 띄웠다"
else
  JOB="$LABEL"
  PLIST="$AGENTS/$LABEL.plist"
  mkdir -p "$AGENTS" "$DATA"
  # /opt/homebrew/etc/redis.conf 는 쓰지 않는다. cask 와 따로 움직여 어긋난다(README).
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SERVER</string>
    <string>--port</string><string>$PORT</string>
    <string>--bind</string><string>127.0.0.1</string>
    <string>--daemonize</string><string>no</string>
    <string>--dir</string><string>$DATA</string>
    <string>--save</string><string>300 10</string>
    <string>--loadmodule</string><string>$MODULES/redisearch.so</string>
    <string>--loadmodule</string><string>$MODULES/rejson.so</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/redis.log</string>
  <key>StandardErrorPath</key><string>$DATA/redis.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || fail "launchd 에 $LABEL 을 못 걸었다"
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  healthy && { say "Redis $REDIS_VERSION + Search $SEARCH_VERSION 을 $PORT 에 띄웠다 (launchd $JOB)"; exit 0; }
  sleep 1
done
LOG="$(plutil -extract StandardErrorPath raw "$PLIST" 2>/dev/null || true)"
[ -n "$LOG" ] && [ -f "$LOG" ] && tail -n 5 "$LOG" | sed 's/^/      /' >&2
fail "$PORT 에 Redis $REDIS_VERSION + Search $SEARCH_VERSION 이 안 떴다 (launchd $JOB)"
