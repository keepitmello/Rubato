#!/bin/bash
# rubato auth — 세 인증의 상태를 보이고, 없는 것을 어떻게 채우는지 알려준다.
#
# 자격증명을 대신 만들지 않는다. 계정 로그인은 각 도구가 자기 흐름으로 해야 하고,
# 그 사이에 스크립트가 끼면 토큰을 엉뚱한 곳에 쓰거나 갱신을 깨뜨린다.
#
# 세 자리가 다르다:
#   xai         ~/.senpi/agent/auth.json 의 "xai"          OAuth (자동 갱신)
#   openai-codex 같은 파일의 "openai-codex"                OAuth (자동 갱신)
#   anthropic   ~/.claude/auth/setup-token-<계정>          1년 장기 토큰 (sk-ant-oat...)
#               없으면 Keychain "Claude Code-setup-token-<계정>"
set -uo pipefail

GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RST=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
miss() { printf '  %s✗%s %s\n' "$YEL" "$RST" "$1"; }
hint() { printf '      %s%s%s\n' "$DIM" "$1" "$RST"; }

SENPI_AUTH="${SENPI_AUTH_PATH:-$HOME/.senpi/agent/auth.json}"
# 정식 이름이 먼저다. `anthropic-setup-token.mjs` 가 `RUBATO_CLAUDE_*` 를 읽으므로, 이
# 스크립트가 legacy 만 보면 정식 이름을 설정한 사람이 서로 다른 계정을 보게 된다.
# legacy `FX_CLAUDE_*` 는 배포 대상이 다 옮겨질 때까지 읽고, 쓰였을 때 한 번만 알린다.
ACCOUNT="${RUBATO_CLAUDE_ACCOUNT:-${FX_CLAUDE_ACCOUNT:-sub}}"
TOKEN_FILE="${RUBATO_CLAUDE_SETUP_TOKEN_FILE:-${FX_CLAUDE_SETUP_TOKEN_FILE:-$HOME/.claude/auth/setup-token-$ACCOUNT}}"

if [ -z "${RUBATO_CLAUDE_ACCOUNT-}" ] && [ -n "${FX_CLAUDE_ACCOUNT-}" ]; then
  printf 'note: FX_CLAUDE_ACCOUNT 는 옛 이름이다. RUBATO_CLAUDE_ACCOUNT 로 바꿔라.\n' >&2
fi
if [ -z "${RUBATO_CLAUDE_SETUP_TOKEN_FILE-}" ] && [ -n "${FX_CLAUDE_SETUP_TOKEN_FILE-}" ]; then
  printf 'note: FX_CLAUDE_SETUP_TOKEN_FILE 는 옛 이름이다. RUBATO_CLAUDE_SETUP_TOKEN_FILE 로 바꿔라.\n' >&2
fi

# auth.json 에 특정 provider 키가 살아 있는지. 만료 시각도 같이 본다.
senpi_has() {
  [ -f "$SENPI_AUTH" ] || return 1
  python3 - "$SENPI_AUTH" "$1" <<'PY' 2>/dev/null
import json, sys, time
path, key = sys.argv[1], sys.argv[2]
try:
    entry = json.load(open(path)).get(key)
except Exception:
    sys.exit(1)
if not isinstance(entry, dict) or not entry.get("access"):
    sys.exit(1)
exp = entry.get("expires")
if isinstance(exp, (int, float)):
    left = exp / 1000 - time.time()
    print("expired" if left < 0 else f"{int(left // 3600)}h")
else:
    print("")
PY
}

printf '\n%s== rubato auth ==%s\n' "$BOLD" "$RST"

# --- xAI
if left="$(senpi_has xai)"; then
  case "$left" in
    expired) miss "xAI — 토큰이 만료됐다"; hint "rubato 를 한 번 띄우면 refresh 로 자동 갱신된다" ;;
    "")      ok   "xAI" ;;
    *)       ok   "xAI  (남은 시간 ~$left)" ;;
  esac
else
  miss "xAI — 없다"
  hint "senpi /login 으로 xAI 를 로그인하면 $SENPI_AUTH 에 들어간다"
fi

# --- Codex
if left="$(senpi_has openai-codex)"; then
  case "$left" in
    expired) miss "Codex — 토큰이 만료됐다"; hint "rubato 를 한 번 띄우면 refresh 로 자동 갱신된다" ;;
    "")      ok   "Codex" ;;
    *)       ok   "Codex  (남은 시간 ~$left)" ;;
  esac
else
  miss "Codex — 없다"
  hint "senpi /login 으로 OpenAI Codex 를 로그인한다"
fi

# --- Claude (장기 토큰)
if [ -f "$TOKEN_FILE" ] && head -c 10 "$TOKEN_FILE" 2>/dev/null | grep -q '^sk-ant-oat'; then
  ok "Claude 장기 setup-token  ($TOKEN_FILE)"
elif security find-generic-password -s "Claude Code-setup-token-$ACCOUNT" >/dev/null 2>&1; then
  ok "Claude 장기 setup-token  (Keychain, 계정 $ACCOUNT)"
else
  miss "Claude — 없다 (계정: $ACCOUNT)"
  hint "claude setup-token 을 돌려 sk-ant-oat... 를 받는다"
  hint "받은 값을 파일로: mkdir -p ~/.claude/auth && pbpaste > $TOKEN_FILE"
  hint "계정 이름을 바꾸려면 RUBATO_CLAUDE_ACCOUNT 를 설정한다"
fi

echo
exit 0
