#!/bin/sh
# Launch rubato-pi with a Node 24+ binary already on the machine.
# This is the default `rubato` alias. Does not change the shell default Node.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
export RUBATO_HUB_RESTART="$HERE/rubato-hub-restart.mjs"

# ANTHROPIC_AUTH_TOKEN 은 엔진이 "bearer" 로 받는다 — OAuth 경로가 아니다.
# 거기에 setup-token(sk-ant-oat)을 담아 두면 Claude Code 신원 없이 요청이 나가고,
# Anthropic 은 haiku 만 통과시키고 opus·sonnet·fable 은 429 로 막는다. setup-token 은
# 키체인에서 읽는 마지막 출처가 제 자리라, env 가 먼저 잡히면 그 자리가 가려진다.
# bridge 시절에는 launchd 가 로그인 셸 env 를 안 물려받아 이 길이 닫혀 있었는데,
# provider 가 세션 안으로 들어오면서 열렸다.
# 진짜 API 키를 이 이름으로 쓰는 설치는 건드리지 않는다 — 접두로만 가른다.
case "${ANTHROPIC_AUTH_TOKEN-}" in
  sk-ant-oat*) unset ANTHROPIC_AUTH_TOKEN ;;
esac

# Subcommands handled here rather than by the agent. Everything else falls
# through to the session launcher, so a prompt starting with an ordinary word
# still works.
if [ "${1-}" = "auth" ]; then
  shift
  exec "$HERE/rubato-auth.sh" "$@"
fi
if [ "${1-}" = "update" ]; then
  shift
  # Live zmx sessions stay up. `remote update-guard` belongs to signed
  # `rubato remote update`, which replaces the install prefix. Git pull plus a
  # hub kickstart must not be blocked by an open pane — hub GC/fixes have to
  # land while other sessions are still running.
  exec "$HERE/rubato-update.sh" "$@"
fi
if [ "${1-}" = "build" ]; then
  shift
  exec "$HERE/../prompts/build.sh" "$@"
fi
if [ "${1-}" = "aside-cursor" ]; then
  shift
  exec "$HERE/rubato-aside-cursor.sh" "$@"
fi
if [ "${1-}" = "dispatch" ]; then
  shift
  exec "$HERE/rubato-dispatch.sh" "$@"
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
  restart)
    if [ "$#" -ne 1 ]; then
      echo "usage: rubato restart" >&2
      exit 2
    fi
    NODE="$(live_node)" || exit $?
    # `restart` 는 "이 워킹트리의 코드로 다시 만들고, 옛 코드로 도는 것을 그 위로
    # 올린다" 이다. 받아오지는 않는다 — git pull 은 `rubato update` 의 몫이고, 그
    # 경계가 두 동사의 전부다.
    #
    # 순서가 정해져 있다. 먼저 만들고 나중에 끈다: 빌드는 길면 몇 분인데 먼저 끄면
    # 그동안 대화를 못 한다. 데스크톱 앱은 맨 뒤다 — 앱이 프로필 엔진에 붙으므로
    # 엔진보다 먼저 켜면 곧 죽을 엔진에 붙는다.
    #
    # 이 기기에 없는 쪽은 조용히 건너뛰고, 한 줄씩 무엇을 했는지 말한다. 종료 0 은
    # "다시 띄웠다"와 "다시 띄울 것이 없었다"를 함께 덮고, 1 은 하려다 실패했다는
    # 뜻이다 — 둘이 같아 보이면 안 된다.
    #
    # 화면에는 진행만 남긴다. 각 단계의 수십 줄짜리 출력은 잘 끝났을 때 아무도
    # 읽지 않으므로 기록으로 보내고, 실패했을 때만 어디를 볼지 말한다.
    . "$HERE/rubato-progress.sh"
    LAUNCHCTL_BIN="${RUBATO_LAUNCHCTL_BIN:-/bin/launchctl}"
    RESTART_GUI="${RUBATO_RESTART_GUI:-$HERE/../t3-integration/restart-gui.sh}"
    RESTART_LOG="${RUBATO_RESTART_LOG:-$HOME/.rubato-pi/logs/rubato-restart.log}"
    mkdir -p "$(dirname "$RESTART_LOG")" 2>/dev/null || true
    RESTART_FAIL=0
    BUILD_DONE=0
    ENGINE_DONE=0
    HUB_DONE=0
    GUI_DONE=0
    trap 'progress_stop' EXIT INT TERM
    printf '\n'

    # 1. 엔진을 이 워킹트리에 맞춘다.
    #
    # 대화가 실제로 실행하는 코드는 레포가 아니라 ~/.rubato-pi/stock-engine 의
    # 설치본이다. 그것을 다시 만드는 자리는 그동안 세션 시작뿐이었고, 그래서
    # `restart` 뒤에 `rubato attach` 로 돌아간 창은 옛 코드를 그대로 돌렸다.
    # 지문이 맞으면 1초쯤에 지나간다 — 다시 만드는 것은 소스가 달라졌을 때뿐이다.
    if [ -z "${RUBATO_NO_ENGINE_BUILD-}" ] && [ -f "$HERE/build-active-engine.mjs" ]; then
      progress_start "엔진이 이 소스에 맞는지 보는 중"
      if "$NODE" "$HERE/build-active-engine.mjs" --check >>"$RESTART_LOG" 2>&1; then
        progress_stop
        ui_skip "엔진은 이미 이 소스에 맞아요"
      else
        progress_start "엔진을 다시 만드는 중 (몇 분 걸려요)"
        if "$NODE" "$HERE/build-active-engine.mjs" >>"$RESTART_LOG" 2>&1; then
          progress_stop
          ui_ok "엔진을 다시 만들었어요"
          BUILD_DONE=1
        else
          progress_stop
          ui_fail "엔진을 다시 만들지 못했습니다. 옛 코드가 그대로입니다 — 기록: $RESTART_LOG"
          RESTART_FAIL=1
        fi
      fi
    fi

    # 2. 프로필 엔진. SIGTERM 만 쓴다 — kill -9 는 프로필 락을 15초 동안 stale 로
    # 남긴다. pid 는 살아 있는 소켓이 가리키는 --agent-dir 로 찾는다.
    # 이 helper 의 stderr 는 끊기는 대화 이름을 말하므로 그대로 사람에게 준다.
    ENGINE_ERR="$(mktemp "${TMPDIR:-/tmp}/rubato-restart.XXXXXX" 2>/dev/null)" || ENGINE_ERR=""
    progress_start "프로필 엔진을 다시 띄우는 중"
    ENGINE_RC=0
    if [ -n "$ENGINE_ERR" ]; then
      ENGINE_OUT="$("$NODE" "$HERE/restart-profile-engine.mjs" 2>"$ENGINE_ERR")" || ENGINE_RC=$?
      ENGINE_NOTE="$(cat "$ENGINE_ERR" 2>/dev/null || true)"
      rm -f "$ENGINE_ERR"
    else
      ENGINE_OUT="$("$NODE" "$HERE/restart-profile-engine.mjs")" || ENGINE_RC=$?
      ENGINE_NOTE=""
    fi
    progress_stop
    if [ "$ENGINE_RC" -eq 0 ]; then
      case "$ENGINE_OUT" in
        restarted*)
          ui_ok "프로필 엔진"
          ENGINE_DONE=1 ;;
        dead*)
          ui_skip "프로필 엔진은 이미 꺼져 있어요" ;;
        *)
          ui_skip "프로필 엔진이 없어요" ;;
      esac
    else
      case "$ENGINE_OUT" in
        no-pid*)
          ui_fail "프로필 엔진 소켓은 살아 있는데 프로세스를 찾지 못했습니다. 옛 코드가 그대로입니다 — 손으로: pgrep -lf 'cli.mjs --agent-dir'" ;;
        timeout*)
          ui_fail "프로필 엔진이 SIGTERM을 받고도 끝나지 않았습니다. 옛 코드가 그대로입니다 — 손으로: pgrep -lf 'cli.mjs --agent-dir'" ;;
        *)
          ui_fail "프로필 엔진을 재시작하지 못했습니다${ENGINE_OUT:+ ($ENGINE_OUT)}. 옛 코드가 그대로입니다 — 손으로: pgrep -lf 'cli.mjs --agent-dir'" ;;
      esac
      RESTART_FAIL=1
    fi
    if [ -n "$ENGINE_NOTE" ]; then
      printf '%s\n' "$ENGINE_NOTE" | while IFS= read -r ENGINE_LINE; do
        if [ -n "$ENGINE_LINE" ]; then
          printf '    \033[2m%s\033[0m\n' "$ENGINE_LINE" >&2
        fi
      done
    fi

    # 3. remote hub. 이 기기에 launch agent 이 등록돼 있을 때만.
    if "$LAUNCHCTL_BIN" print "gui/$(id -u)/com.keepitmello.rubato.remote-hub" >/dev/null 2>&1; then
      progress_start "remote hub 을 다시 띄우는 중"
      if "$NODE" "$HERE/rubato-hub-restart.mjs" >>"$RESTART_LOG" 2>&1; then
        progress_stop
        ui_ok "remote hub"
        HUB_DONE=1
      else
        progress_stop
        ui_fail "remote hub 재시작에 실패했습니다. 옛 코드가 그대로입니다 — 손으로: node \"$HERE/rubato-hub-restart.mjs\""
        RESTART_FAIL=1
      fi
    else
      ui_skip "remote hub 은 이 기기에 없어요"
    fi

    # Desktop app last: it connects to the profile engine, so relaunching it
    # before the engine restart would attach it to an engine that is about to
    # die. Everything about how the app is stopped, rebuilt and brought back
    # lives in restart-gui.sh, which `rubato update` calls too — one place, so
    # the two verbs cannot drift apart. Its exit code says which happened:
    # 0 did something, 1 tried and failed, 2 no app on this machine.
    if [ -f "$RESTART_GUI" ]; then
      # `set -e` is on: capture the status instead of letting a non-zero exit
      # end the run before the summary line.
      GUI_STATUS=0
      sh "$RESTART_GUI" || GUI_STATUS=$?
      case "$GUI_STATUS" in
        0) GUI_DONE=1 ;;
        2) : ;;
        *) RESTART_FAIL=1 ;;
      esac
    else
      ui_skip "데스크톱 앱이 없어요"
    fi

    # 사람이 해야 할 일은 하나뿐이고, 마지막에 한 번만 말한다. 단계마다 붙이면
    # 같은 말이 세 번 나오고, 정작 무엇을 하라는 것인지는 안 남는다.
    if [ "$ENGINE_DONE" = 1 ]; then
      printf '\n  대화는 그대로 있어요. 열어 둔 창은 연결이 끊겼으니 %srubato%s 를 다시 실행해 이어가세요.\n' \
        "$PROGRESS_DIM" "$PROGRESS_RST"
    fi
    if [ "$BUILD_DONE" = 0 ] && [ "$ENGINE_DONE" = 0 ] && [ "$HUB_DONE" = 0 ] && [ "$GUI_DONE" = 0 ] && [ "$RESTART_FAIL" = 0 ]; then
      printf '\n  다시 띄울 것이 없었어요 (프로필 엔진·remote hub·데스크톱 앱 모두 이 기기에 없거나 꺼져 있어요).\n'
    fi
    printf '\n'
    exit "$RESTART_FAIL"
    ;;
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
    --print|--mode=rpc|--mode=print|--help|-h|--version|-v) RUBATO_NONINTERACTIVE=1 ;;
    --mode) EXPECT_MODE=1 ;;
  esac
done

# Windows Git Bash cannot host the Unix live hub. Direct session is the path.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) RUBATO_LIVE_DIRECT=1 ;;
esac

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
splash() { [ -z "$RUBATO_NONINTERACTIVE" ] && [ -x "$SPLASH" ] && "$SPLASH" "$@" || true; }
# 워드마크는 splash open 이 바로 찍고, 애니메이션은 아래에서 붙는다. 스킬·엔진 준비
# 같은 셸 단계 동안 화면이 멈춰 있지 않도록 작은 렌더러를 뒤에 띄운다. 엔진
# Node 가 뜨면 같은 화면과 시계를 넘겨받아 인트로가 다시 돌지 않는다
# (boot-chrome.mjs adoptShellSplash). 렌더러의 부모는 이 셸이고 exec 뒤에는 엔진이
# 같은 pid 를 잇는다. open 이 실제로 그렸을 때만 $DIR/open 을 남긴다.
if [ -z "$RUBATO_NONINTERACTIVE" ] && [ -x "$SPLASH" ] \
  && RUBATO_BOOT_SPLASH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rubato-splash.XXXXXX" 2>/dev/null)"; then
  export RUBATO_BOOT_SPLASH_DIR
else
  RUBATO_BOOT_SPLASH_DIR=""
fi
splash open

ROOT="$(CDPATH= cd -- "$HERE/../rubato-pi" && pwd)"
# node 를 찾는 곳은 한 군데다. 예전에는 여기서 nvm 경로를 박아 뒀는데, 그 버전이
# 사라지면 조용히 PATH 의 아무 node 로 떨어졌다.
. "$HERE/find-node.sh"
if ! NODE="$(rubato_find_node)"; then
  splash close
  echo "rubato-pi needs Node.js 24+ already installed. Default Node was not changed." >&2
  exit 2
fi

SPLASH_PID=""
if [ -n "$RUBATO_BOOT_SPLASH_DIR" ] && [ -f "$RUBATO_BOOT_SPLASH_DIR/open" ]; then
  # 엔진 훅(NODE_OPTIONS)은 렌더러에 싣지 않는다. 기동을 느리게 할 뿐이다.
  NODE_OPTIONS= "$NODE" "$ROOT/src/boot-splash.mjs" "$RUBATO_BOOT_SPLASH_DIR" </dev/null 2>/dev/null &
  SPLASH_PID=$!
elif [ -n "$RUBATO_BOOT_SPLASH_DIR" ]; then
  rm -rf "$RUBATO_BOOT_SPLASH_DIR"
  RUBATO_BOOT_SPLASH_DIR=""
  unset RUBATO_BOOT_SPLASH_DIR
fi

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
cleanup() {
  splash close
  if [ -n "${SPLASH_PID-}" ]; then
    wait "$SPLASH_PID" 2>/dev/null || true
  fi
  if [ -n "${UPDATE_PID-}" ]; then
    kill "$UPDATE_PID" 2>/dev/null || true
    wait "$UPDATE_PID" 2>/dev/null || true
  fi
  if [ -n "${MSEARCH_PID-}" ]; then
    kill "$MSEARCH_PID" 2>/dev/null || true
    wait "$MSEARCH_PID" 2>/dev/null || true
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
"$HERE/../prompts/build.sh" >/dev/null

# 스킬은 `rubato update` 가 맞춘다. 예전 업데이터는 있는 스킬을 건너뛰어서
# 소스는 새데 ~/.agents/skills 는 낡은 기기가 생겼다. HEAD 가 마지막
# 설치와 다르면 여기서 한 번 더 맞춘다. 실패해도 세션은 띄운다.
REPO="$(CDPATH= cd -- "$HERE/../.." && pwd)"
SKILLS_STAMP="${RUBATO_SKILLS_STAMP:-$HOME/.rubato-pi/skills-bundle-head}"
SKILLS_HEAD="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
if [ -n "$SKILLS_HEAD" ] && [ "$(cat "$SKILLS_STAMP" 2>/dev/null || true)" != "$SKILLS_HEAD" ]; then
  splash step "스킬을 맞추는 중"
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

# cmux 세션 복원을 붙인다. 이게 없으면 cmux 를 꺼다 켜는 순간 세션이
# 통째로 날아간다. cmux 를 안 쓰면 아무 일도 안 생기고, 이미 맞으면 조용하다.
# 경로가 어긋난 때도(하네스를 옮기면 절대경로가 깨진다) 여기서 고친다.
# 쓰면 JSONC 주석을 잃어서 백업을 남긴다. 실패해도 세션을 막지 않는다.
if [ -z "${RUBATO_NO_VAULT-}" ] && [ -f "$HOME/.config/cmux/cmux.json" ]; then
  "$NODE" "$HERE/cmux-vault.mjs" --apply >/dev/null 2>&1 || true
fi

# 예전 Kiro 자격에 clientId 가 없으면 accessToken 만료 뒤 갱신이 끊긴다.
# 자격 파일만 고치고 Docker 는 띄우지 않는다. 사이드카 복원은 실제 kiro/* 요청이
# 처음 들어온 provider 경계가 맡는다.
if [ -z "${RUBATO_NO_KIRO_HEAL-}" ] && [ -x "$HERE/kiro-setup.sh" ]; then
  "$HERE/kiro-setup.sh" heal >/dev/null 2>&1 || true
fi

# pi 설치본은 `rubato update` 가 git 이 이미 최신이면 다시 안 깐다.
# 이 머신에서 커밋한 직후 `rubato` 만 치면 낡은 stock-engine 이 그대로 떴다.
# 지문이 다르면 세션 전에 다시 깐다. --version/-v 는 기다리지 않는다.
STOCK_REBUILD=1
case "${1-}" in --version|-v|--help|-h) STOCK_REBUILD="" ;; esac
if [ -n "$STOCK_REBUILD" ] && [ -z "${RUBATO_NO_ENGINE_BUILD-}" ] && [ -f "$HERE/build-active-engine.mjs" ]; then
  splash step "엔진을 확인하는 중"
  if ! "$NODE" "$HERE/build-active-engine.mjs" --check >/dev/null 2>&1; then
    splash step "엔진을 다시 만드는 중"
    if ! "$NODE" "$HERE/build-active-engine.mjs"; then
      echo "rubato: pi 엔진을 맞추지 못했습니다. 손으로: node harness/scripts/build-active-engine.mjs" >&2
      exit 1
    fi
  fi
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

# 확인 질문은 정상 화면에서 받고, 그 외에는 Node가 같은 화면을 인계받는다.
if [ -n "$UPDATE_NOTE" ]; then splash close; fi
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
      exec /bin/sh "$HERE/rubato-pi.sh" "$@"
    fi
    printf '\n'
  fi
fi

if [ -n "$UPDATE_NOTE" ]; then printf '%s\n\n' "$UPDATE_NOTE" >&2; fi


# Engine selection is owned by launch.mjs via RUBATO_ENGINE
# and ~/.rubato-pi/engine.json. This shell keeps splash/boot chrome and the
# Senpi plugin build. Senpi fallback is retired: launch.mjs fails loud when
# the pi install is missing or invalid.
exec "$NODE" "$ROOT/bin/rubato-pi.mjs" "$@"
