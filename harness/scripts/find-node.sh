# POSIX sh 조각. source 해서 쓴다.
#
#   . "$HERE/find-node.sh"
#   NODE="$(rubato_find_node)" || exit 2
#
# node 를 찾는 자리가 셋이었다 — rubato-pi.sh 의 하드코딩 nvm 경로, start.sh 의
# 맨 `exec node`, 그리고 select-node.mjs. 셋이 다른 답을 낼 수 있다는 것이
# 문제였고, 특히 start.sh 는 PATH 에만 기댔다. launchd 는 로그인 셸 환경을
# 물려주지 않아 PATH 가 /usr/bin:/bin 수준이라 nvm node 가 보이지 않고,
# `--experimental-strip-types` 는 Node 22.6+ 를 요구해 시스템 node 로는 브리지가
# 조용히 죽는다. 이제 셋 다 여기를 지난다.
#
# 최종 판단은 select-node.mjs(정본)에 맡긴다. 여기서 하는 일은 그것을 **실행할
# 수 있는** node 하나를 찾는 것뿐이라 부트스트랩은 24 미만이어도 된다 — 그 파일은
# 평범한 ESM 이다.
#
# 후보 순서는 환경과 무관하게 고정한다. PATH 를 먼저 보면 터미널에서는 로그인
# 셸의 node 가, launchd 에서는 /usr/bin/node 가 잡혀 **같은 기계에서 브리지가
# 두 얼굴을 갖는다.** nvm 을 먼저 보는 이유가 그것이다.
#
# 특정 node 를 강제하려면 RUBATO_NODE 로 준다.

rubato_node_candidates() {
  [ -n "${RUBATO_NODE-}" ] && printf '%s\n' "$RUBATO_NODE"
  nvm_root="${NVM_DIR:-${HOME:-/nonexistent}/.nvm}/versions/node"
  if [ -d "$nvm_root" ]; then
    for bin in "$nvm_root"/v*/bin/node; do
      [ -x "$bin" ] && printf '%s\n' "$bin"
    done
  fi
  for bin in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$bin" ] && printf '%s\n' "$bin"
  done
  command -v node 2>/dev/null || true
}

# 고른 node 의 절대경로를 stdout 으로 낸다. 하나도 못 찾으면 1 로 끝난다.
rubato_find_node() {
  _select="${RUBATO_SELECT_NODE:-$(CDPATH= cd -- "$(dirname "$0")" && pwd)/../rubato-pi/scripts/select-node.mjs}"
  rubato_node_candidates | while IFS= read -r candidate; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    if [ -f "$_select" ]; then
      picked="$("$candidate" "$_select" --print 2>/dev/null)" || continue
    else
      # select-node.mjs 가 없는 배치에서는 후보 자신이 24+ 인지만 본다.
      major="$("$candidate" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null)" || continue
      [ -n "$major" ] && [ "$major" -ge 24 ] 2>/dev/null || continue
      picked="$candidate"
    fi
    if [ -n "$picked" ] && [ -x "$picked" ]; then
      printf '%s\n' "$picked"
      return 0
    fi
  done | head -1 | grep . || return 1
}
