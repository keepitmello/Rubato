#!/bin/bash
# rubato auth — 상태, 그리고 `login` 으로 엔진 OAuth.
#
# 세 자리가 다르다:
#   xai         ~/.rubato-pi/agent/auth.json 의 "xai"          OAuth
#   openai-codex 같은 파일의 "openai-codex"                    OAuth
#   anthropic   ~/.claude/auth/setup-token-<계정>              1년 장기 토큰
set -uo pipefail

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

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

. "$HERE/find-node.sh"
if ! NODE="$(rubato_find_node)"; then
  echo "rubato auth needs Node.js 24+ already installed." >&2
  exit 2
fi
exec "$NODE" "$HERE/rubato-auth.mjs" "$@"
