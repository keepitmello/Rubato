# 에이전트 세션이 자기가 올라탄 데스크톱 앱을 직접 껐다 켜지 못하게 한다.
# (restart-gui.sh 와 start-gui.sh 가 source 한다.)
#
# 에이전트의 셸에는 PI_SESSION_ID 가 있다. 그 세션이 돌던 도중 앱이 내려가면 T3 가
# 이벤트를 못 받고 스레드가 "Thinking" 으로 굳는다. 앱이 올라오는 동안 T3 의 재시작
# 복구(continueThreadsAfterServerUpdate)가 도는데, 에이전트가 이어서 앱을 또 죽이고
# 또 켜면(2026-10-06 실사고: 20초 사이 두 번) 복구가 중간에 끊겨 projection 은
# running, 바인딩은 stopped 로 어긋난 채 남았다.
#
# 사람이 터미널에서 돌리거나 앱의 업데이트 버튼이 돌릴 때는 PI_SESSION_ID 가 없다.
# 앱의 업데이트 버튼이 부르는 경로(RUBATO_GUI_UPDATE_*)는 에이전트가 아니므로 막지
# 않는다. 정말 에이전트가 해야 하면 RUBATO_ALLOW_AGENT_GUI_RESTART=1 로 명시한다.
refuse_from_agent() {
  [ -n "${PI_SESSION_ID-}" ] || return 0
  [ "${RUBATO_ALLOW_AGENT_GUI_RESTART-}" = 1 ] && return 0
  [ -z "${RUBATO_GUI_UPDATE_NODE-}" ] || return 0
  [ "${RUBATO_GUI_UPDATE_RELAUNCH-}" != 1 ] || return 0
  cat >&2 <<'MSG'
에이전트 세션에서는 데스크톱 앱을 직접 껐다 켜지 않습니다.
이 세션이 도는 중에 앱이 내려가면 화면이 이벤트를 못 받아 스레드가 "Thinking" 으로 굳습니다.
사용자에게 알려서 직접 재시작하게 하세요 (터미널에서 `rubato restart`).
정말 이 세션이 해야 하는 일이면: RUBATO_ALLOW_AGENT_GUI_RESTART=1 을 붙여 다시 부르세요.
MSG
  return 1
}
