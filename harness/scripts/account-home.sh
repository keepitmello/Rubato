# Sourced. Whether HOME is this account's own home.
#
# Tests and sandboxes run with a temporary HOME, and everything under HOME follows
# it. /Applications/Rubato.app, the app itself (quit by name), and launchctl
# services do not: there is one of each per account, whatever HOME says. A test
# that reached `rubato restart` with a temporary HOME quit the running app and
# pointed /Applications/Rubato.app at a bundle in /var/folders. So those defaults
# are used only from the account's home. A caller that names the resource in an
# environment variable (as the tests do) has chosen it, and is not stopped.
rubato_home_is_account_home() {
  _account_home="$(eval "printf '%s' ~$(id -un)")"
  [ -n "$_account_home" ] || return 1
  [ "$(cd "$HOME" 2>/dev/null && pwd -P)" = "$(cd "$_account_home" 2>/dev/null && pwd -P)" ]
}
