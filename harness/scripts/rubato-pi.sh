#!/bin/sh
# Launch rubato-pi with a Node 24+ binary already on the machine.
# This is the default `rubato` alias. Does not change the shell default Node.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

# Subcommands handled here rather than by the agent. Everything else falls
# through to the session launcher, so a prompt starting with an ordinary word
# still works.
if [ "${1-}" = "auth" ]; then
  shift
  exec "$HERE/rubato-auth.sh" "$@"
fi
if [ "${1-}" = "update" ]; then
  shift
  . "$HERE/find-node.sh"
  if ! NODE="$(rubato_find_node)"; then
    echo "rubato update preflight needs Node.js 24+ already installed." >&2
    exit 2
  fi
  LIVE_CLI="$HERE/../../packages/rubato-live-cli/bin/rubato-live.mjs"
  "$NODE" "$LIVE_CLI" remote update-guard
  exec "$HERE/rubato-update.sh" "$@"
fi
if [ "${1-}" = "build" ]; then
  shift
  exec "$HERE/../prompts/build.sh" "$@"
fi

# `direct` 는 dispatcher 만 건너뛴다. 기존 준비·엔진 경로는 그대로 지나므로
# auth/update/build 외의 과거 사용법과 bootstrap 이 같은 엔진을 실행한다.
RUBATO_LIVE_DIRECT=""
if [ "${1-}" = "direct" ]; then
  shift
  RUBATO_LIVE_DIRECT=1
  export RUBATO_LIVE_DIRECT
fi

LIVE_CLI="$HERE/../../packages/rubato-live-cli/bin/rubato-live.mjs"
LIVE_BOOTSTRAP="$HERE/remote/rubato-live-bootstrap.mjs"
live_node() {
  . "$HERE/find-node.sh"
  if ! rubato_find_node; then
    echo "rubato live commands need Node.js 24+ already installed." >&2
    return 2
  fi
}

case "${1-}" in
  new|attach|list|kill|remote|vault-resume|vault-fork)
    NODE="$(live_node)" || exit $?
    exec "$NODE" "$LIVE_CLI" "$@"
    ;;
  internal-run)
    if [ "${2-}" != "--descriptor" ] || [ -z "${3-}" ] || [ "$#" -ne 3 ]; then
      echo "usage: rubato internal-run --descriptor <path>" >&2
      exit 2
    fi
    NODE="$(live_node)" || exit $?
    exec "$NODE" "$LIVE_BOOTSTRAP" "$3"
    ;;
esac

# Dispatcher 는 실제 terminal 대화에만 개입한다. pipe/RPC/print/CI/dumb terminal 과
# zmx 안의 재귀 호출은 아래의 기존 엔진으로 그대로 보낸다.
RUBATO_NONINTERACTIVE=""
EXPECT_MODE=""
for RUBATO_ARG in "$@"; do
  if [ -n "$EXPECT_MODE" ]; then
    case "$RUBATO_ARG" in rpc|print) RUBATO_NONINTERACTIVE=1 ;; esac
    EXPECT_MODE=""
  fi
  case "$RUBATO_ARG" in
    --print|--mode=rpc|--mode=print) RUBATO_NONINTERACTIVE=1 ;;
    --mode) EXPECT_MODE=1 ;;
  esac
done

if [ -z "$RUBATO_LIVE_DIRECT" ] \
  && [ "${RUBATO_LIVE_MODE-}" != "off" ] \
  && [ -z "${ZMX_SESSION-}" ] \
  && [ -z "${CI-}" ] \
  && [ "${TERM-}" != "dumb" ] \
  && [ -z "$RUBATO_NONINTERACTIVE" ] \
  && [ -t 0 ] && [ -t 1 ]; then
  NODE="$(live_node)" || exit $?
  if [ "$#" -eq 0 ]; then
    LIVE_COMMAND="pick"
  else
    LIVE_COMMAND="new"
  fi
  if [ "$LIVE_COMMAND" = "pick" ]; then
    if "$NODE" "$LIVE_CLI" pick; then exit 0; else LIVE_RC=$?; fi
  else
    if "$NODE" "$LIVE_CLI" new -- "$@"; then exit 0; else LIVE_RC=$?; fi
  fi
  if [ "$LIVE_RC" -ne 75 ]; then exit "$LIVE_RC"; fi
  echo "rubato: live session service is unavailable; starting a direct unmanaged session" >&2
fi

# 부팅 스플래시. 엔진이 화면을 잡기까지 3초 남짓 걸리는데 그동안 까만
# 화면을 두지 않는다. 그릴 수 없는 곳에서는 splash 가 스스로 빠진다.
SPLASH="$HERE/rubato-splash.sh"
splash() { [ -x "$SPLASH" ] && "$SPLASH" "$@" || true; }
splash open

# 스플래시를 켜 둔 채로 죽으면 커서가 사라진 터미널이 남는다. 어떻게
# 끝나든 커서는 되돌린다. 업데이트 확인을 백그라운드로 돌리면 그 임시
# 파일도 같이 치운다.
UPDATE_NOTE=""
UPDATE_COUNT=""
UPDATE_PID=""
UPDATE_OUT=""
UPDATE_DONE=""
MSEARCH_PID=""
MSEARCH_OUT=""
MSEARCH_DONE=""
ENGINE_PID=""
cleanup() {
  if [ -n "${UPDATE_PID-}" ]; then
    kill "$UPDATE_PID" 2>/dev/null || true
    wait "$UPDATE_PID" 2>/dev/null || true
  fi
  if [ -n "${MSEARCH_PID-}" ]; then
    kill "$MSEARCH_PID" 2>/dev/null || true
    wait "$MSEARCH_PID" 2>/dev/null || true
  fi
  if [ -n "${ENGINE_PID-}" ]; then
    kill "$ENGINE_PID" 2>/dev/null || true
    wait "$ENGINE_PID" 2>/dev/null || true
  fi
  [ -n "${UPDATE_OUT-}" ] && rm -f "$UPDATE_OUT"
  [ -n "${UPDATE_DONE-}" ] && rm -f "$UPDATE_DONE"
  [ -n "${MSEARCH_OUT-}" ] && rm -f "$MSEARCH_OUT"
  [ -n "${MSEARCH_DONE-}" ] && rm -f "$MSEARCH_DONE"
  printf '\033[?25h'
}
trap cleanup EXIT INT TERM

# fetch 는 0.5초라 프롬프트·엔진 준비와 겹친다. 결과는 스플래시를
# 닫기 직전에 받는다. 묻는 시점과 문구는 예전과 같다.
if [ -z "${RUBATO_NO_UPDATE_CHECK-}" ] && [ -x "$HERE/rubato-update.sh" ]; then
  UPDATE_OUT="$(mktemp "${TMPDIR:-/tmp}/rubato-update.XXXXXX")" || UPDATE_OUT=""
  if [ -n "$UPDATE_OUT" ]; then
    UPDATE_DONE="$UPDATE_OUT.done"
    (
      set +e
      note=$("$HERE/rubato-update.sh" --check 2>&1 >/dev/null)
      rc=$?
      printf '%s\n' "$rc"
      printf '%s' "$note"
      : >"$UPDATE_DONE"
    ) >"$UPDATE_OUT" 2>/dev/null &
    UPDATE_PID=$!
  fi
fi

# 로컬에서 프롬프트 조각을 고친 뒤 build.sh 를 잊어도 새 세션에는 바로
# 반영한다. 합성은 보통 0.01초고, 실패하면 낡은 프롬프트로 시작하지 않는다.
splash step "프롬프트"
"$HERE/../prompts/build.sh" >/dev/null

# 스킬은 `rubato update` 가 맞춘다. 예전 업데이터는 있는 스킬을 건너뛰어서
# 소스는 새데 ~/.agents/skills 는 낡은 기기가 생겼다. HEAD 가 마지막
# 설치와 다르면 여기서 한 번 더 맞춘다. 실패해도 세션은 띄운다.
REPO="$(CDPATH= cd -- "$HERE/../.." && pwd)"
SKILLS_STAMP="${RUBATO_SKILLS_STAMP:-$HOME/.rubato-pi/skills-bundle-head}"
SKILLS_HEAD="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
if [ -n "$SKILLS_HEAD" ] && [ "$(cat "$SKILLS_STAMP" 2>/dev/null || true)" != "$SKILLS_HEAD" ]; then
  splash step "스킬"
  SKILLS_PREV="$(cat "$SKILLS_STAMP" 2>/dev/null || true)"
  [ -n "$SKILLS_PREV" ] || SKILLS_PREV="$(git -C "$REPO" rev-parse 'HEAD@{1}' 2>/dev/null || true)"
  if [ -n "$SKILLS_PREV" ]; then
    "$HERE/install-skills.sh" --sync-from "$SKILLS_PREV" >/dev/null 2>&1 || true
  else
    "$HERE/install-skills.sh" >/dev/null 2>&1 || true
  fi
fi

# msearch 가 죽어도 세션은 멀쩡히 떠서 죽음이 보이지 않는다 — 쓰기(memory 도구)는
# 검색과 별개로 멀쩡해서 더 안 보인다. 한 머신에서 검색이 이틀 넘게 죽어
# 있었는데 세션들이 과거 교훈을 못 읽으며 같은 실수를 반복했다. 죽어 있을
# 때만 한 줄 남기고 세션은 막지 않는다.
MSEARCH_BIN="$HERE/../msearch/msearch"
if [ -z "${RUBATO_NO_MSEARCH_CHECK-}" ] && [ -x "$MSEARCH_BIN" ]; then
  MSEARCH_OUT="$(mktemp "${TMPDIR:-/tmp}/rubato-msearch.XXXXXX")" || MSEARCH_OUT=""
  if [ -n "$MSEARCH_OUT" ]; then
    MSEARCH_DONE="$MSEARCH_OUT.done"
    (
      set +e
      "$MSEARCH_BIN" --health >/dev/null 2>"$MSEARCH_OUT"
      printf '%s\n' "$?" >"$MSEARCH_DONE"
    ) &
    MSEARCH_PID=$!
  fi
fi

ROOT="$(CDPATH= cd -- "$HERE/../rubato-pi" && pwd)"
# node 를 찾는 곳은 한 군데다. 예전에는 여기서 nvm 경로를 박아 뒀는데, 그 버전이
# 사라지면 조용히 PATH 의 아무 node 로 떨어졌다.
splash step "node"
. "$HERE/find-node.sh"
if ! NODE="$(rubato_find_node)"; then
  echo "rubato-pi needs Node.js 24+ already installed. Default Node was not changed." >&2
  exit 2
fi

# 옛 설치의 사용자 상태와 현재 프로젝트 설정을 새 정본으로 옮긴다.
# 홈과 cwd 조상에 옛 루트가 하나도 없으면 Node 프로세스조차 띄우지 않는다.
RUBATO_NEEDS_MIGRATION=""
if [ -e "$HOME/.omo" ] || [ -L "$HOME/.omo" ] \
  || [ -e "$HOME/.rubato/.migration-archive/omo" ] \
  || [ -e "$HOME/.rubato/.migration-archive/rubato" ]; then
  RUBATO_NEEDS_MIGRATION=1
else
  MIGRATION_ROOT="$PWD"
  MIGRATION_BOUNDARY="$HOME"
  while [ "$MIGRATION_ROOT" != "$MIGRATION_BOUNDARY" ] && [ "$(dirname "$MIGRATION_ROOT")" != "$MIGRATION_ROOT" ]; do
    if [ -e "$MIGRATION_ROOT/.omo" ] || [ -L "$MIGRATION_ROOT/.omo" ] \
      || [ -e "$MIGRATION_ROOT/.rubato/.migration-archive/omo" ] \
      || [ -e "$MIGRATION_ROOT/.rubato/.migration-archive/rubato" ]; then
      RUBATO_NEEDS_MIGRATION=1
      break
    fi
    MIGRATION_ROOT="$(dirname "$MIGRATION_ROOT")"
  done
fi
if [ -n "$RUBATO_NEEDS_MIGRATION" ] && [ -f "$HERE/migrate-rubato-state.mjs" ]; then
  "$NODE" "$HERE/migrate-rubato-state.mjs" --cwd "$PWD"
fi

# 엔진 산출물을 레포 밖에 준비한다. 이미 신선하면 즉시 끝나고(해시 비교만
# 한다), 소스를 고쳤거나 처음이면 그때만 다시 만든다.
#
# 레포 안이 아니라 밖에 만드는 이유는 engine-paths.mjs 첫머리에 있다 — 요약하면
# 빌드가 추적 파일을 다시 쓰면 worktree 가 영구히 dirty 가 되어 업데이트가 막힌다.
# 실패해도 여기서 세션을 막지 않는다. 산출물이 정말 없으면 assertEngineBuilt 가
# 사유를 들고 세운다.
if [ -z "${RUBATO_NO_ENGINE_BUILD-}" ] && [ -f "$HERE/build-engine.mjs" ]; then
  splash step "엔진 빌드"
  "$NODE" "$HERE/build-engine.mjs" >/dev/null 2>&1 &
  ENGINE_PID=$!
else
  ENGINE_PID=""
fi

# cmux 세션 복원을 붙인다. 이게 없으면 cmux 를 꺼다 켜는 순간 세션이
# 통째로 날아간다. cmux 를 안 쓰면 아무 일도 안 생기고, 이미 맞으면 조용하다.
# 경로가 어긋난 때도(하네스를 옮기면 절대경로가 깨진다) 여기서 고친다.
# 쓰면 JSONC 주석을 잃어서 백업을 남긴다. 실패해도 세션을 막지 않는다.
if [ -z "${RUBATO_NO_VAULT-}" ] && [ -f "$HOME/.config/cmux/cmux.json" ]; then
  splash step "세션 복원"
  "$NODE" "$HERE/cmux-vault.mjs" --apply >/dev/null 2>&1 || true
fi

# 예전 Kiro 자격에 clientId 가 없으면 accessToken 만료 뒤 갱신이 끊긴다.
# 자격 파일만 고치고 Docker 는 띄우지 않는다. 사이드카 복원은 실제 kiro/* 요청이
# 처음 들어온 provider 경계가 맡는다.
if [ -z "${RUBATO_NO_KIRO_HEAL-}" ] && [ -x "$HERE/kiro-setup.sh" ]; then
  "$HERE/kiro-setup.sh" heal >/dev/null 2>&1 || true
fi

# 신선도 검사/빌드는 위의 독립 준비와 겹치되, 엔진을 실행하기 전에는 끝나야 한다.
if [ -n "$ENGINE_PID" ]; then
  wait "$ENGINE_PID" || true
  ENGINE_PID=""
fi

# 기억 검색 생존 판정도 준비와 겹친다. 실패 문구 계약은 그대로 유지한다.
if [ -n "$MSEARCH_PID" ]; then
  if [ -f "$MSEARCH_DONE" ]; then
    wait "$MSEARCH_PID" || true
    MSEARCH_PID=""
    MSEARCH_RC="$(cat "$MSEARCH_DONE" 2>/dev/null || echo 1)"
    if [ "$MSEARCH_RC" -ne 0 ]; then
      MSEARCH_NOTE="$(cat "$MSEARCH_OUT" 2>/dev/null || true)"
      printf 'rubato: 기억 검색(msearch)이 죽어 있다 — %s\n' "${MSEARCH_NOTE:-원인 불명}" >&2
    fi
  else
    kill "$MSEARCH_PID" 2>/dev/null || true
    wait "$MSEARCH_PID" 2>/dev/null || true
    MSEARCH_PID=""
  fi
  rm -f "$MSEARCH_OUT"
  rm -f "$MSEARCH_DONE"
  MSEARCH_OUT=""
  MSEARCH_DONE=""
fi

# 준비와 겹친 동안 끝난 fetch 만 받는다. 네트워크가 느린 날에도 업데이트 확인이
# 엔진 시작을 붙잡아서는 안 된다. 아직 출력이 없으면 이번 알림만 건너뛴다.
if [ -n "${UPDATE_PID-}" ]; then
  splash step "업데이트 확인"
  if [ -n "$UPDATE_OUT" ] && [ -f "$UPDATE_DONE" ]; then
    wait "$UPDATE_PID" || true
    UPDATE_PID=""
    UPDATE_RC="$(sed -n '1p' "$UPDATE_OUT")"
    UPDATE_NOTE="$(sed '1d' "$UPDATE_OUT")"
    rm -f "$UPDATE_OUT"
    rm -f "$UPDATE_DONE"
    UPDATE_OUT=""
    UPDATE_DONE=""
    if [ "$UPDATE_RC" != 10 ]; then
      UPDATE_NOTE=""
    else
      # 몇 개인지는 이미 받은 문구에서 뽑는다. 다시 물으면 fetch 가 한 번 더 돈다.
      # 문구에는 색 코드가 섞여 있고 그 안에도 숫자가 있다(\033[33m). 그대로
      # 숫자만 긁으면 "3개" 가 "3330개" 로 둔갑한다. 색부터 벗긴다.
      UPDATE_COUNT="$(printf '%s' "$UPDATE_NOTE" \
        | sed 's/\033\[[0-9;]*m//g' \
        | sed -n 's/.*업데이트 \([0-9][0-9]*\)개.*/\1/p')"
    fi
  else
    kill "$UPDATE_PID" 2>/dev/null || true
    wait "$UPDATE_PID" 2>/dev/null || true
    UPDATE_PID=""
    rm -f "$UPDATE_OUT"
    rm -f "$UPDATE_DONE"
    UPDATE_OUT=""
    UPDATE_DONE=""
  fi
fi

# 그린 것을 지우고 한 줄만 남긴다. 엔진은 이 다음부터 화면을 잡는다.
splash step "엔진"
splash close "엔진 시작"
trap - EXIT INT TERM

# 새 커밋이 있으면 받을지 물어본다. 예면 받아서 다시 만들고, 그 뒤에
# 새 코드로 세션을 시작한다. 아니오면 알림 한 줄만 남기고 그대로 간다.
#
# 묻는 것 자체가 안 되는 곳(파이프, CI, TERM=dumb)에서는 confirm 이 스스로
# 1 로 빠지므로 예전처럼 한 줄 알림만 남는다.
if [ -n "$UPDATE_NOTE" ] && [ -z "${RUBATO_NO_UPDATE_PROMPT-}" ]; then
  QUESTION="rubato 업데이트 ${UPDATE_COUNT:-여러}개를 받을까?"
  if "$NODE" "$HERE/rubato-confirm.mjs" "$QUESTION" --default-no; then
    UPDATE_NOTE=""
    # 받기로 했으면 여기서 끝까지 보여준다. 받기·빌드는 길면 몇 분이라
    # 진행을 감추면 멈춘 것처럼 보인다.
    if "$HERE/rubato-update.sh" --yes; then
      # 받은 뒤에는 새 코드로 다시 시작한다. 이 스크립트 자체도 바뀌었을 수
      # 있으므로 이어서 도는 대신 처음부터 다시 들어간다. 무한루프를 막기
      # 위해 두 번째부터는 묻지 않는다.
      # 재실행이라 스플래시를 또 그리면 로고가 두 번 뜼고 어수선해진다.
      # 두 번째는 조용히 들어간다.
      RUBATO_NO_UPDATE_PROMPT=1 RUBATO_NO_SPLASH=1
      export RUBATO_NO_UPDATE_PROMPT RUBATO_NO_SPLASH
      exec "$HERE/rubato-pi.sh" "$@"
    fi
    printf '\n'
  fi
fi

if [ -n "$UPDATE_NOTE" ]; then printf '%s\n\n' "$UPDATE_NOTE" >&2; fi

exec "$NODE" "$ROOT/bin/rubato-pi.mjs" "$@"
