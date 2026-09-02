#!/bin/bash
# Rubato 하네스 설치. 이 레포만으로 끝난다.
#
# 기본은 계획만 출력한다(dry-run). 실제로 깔려면 --apply.
#
# 하는 일: 엔진·의존성 설치 → 역할별 시스템 프롬프트 합성 → ~/.agents/rubato 심링크
#          → 번들 스킬을 ~/.agents/skills 로 → 셸 alias → 대화형·비대화형 확인
#
# 크레덴셜은 만들지 않는다. 있는지 보고 없으면 알려만 준다.
set -uo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$REPO/harness"
APPLY=0
# --only-shell 은 셸 설정(alias 블록, cmux Vault)만 다시 심는다.
# 업데이트가 이걸 부른다 — alias 목록을 두 군데 두면 어깋나기 때문에
# 정본은 여기 하나로 둔다. 의존성·빌드는 건드리지 않는다.
ONLY_SHELL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --only-shell) ONLY_SHELL=1 ;;
    --help|-h)
      printf '%s\n' '사용법: ./install.sh [--apply] [--only-shell]' '' \
        '  인자 없음               설치 계획만 출력한다' \
        '  --apply                 이 클론에서 Rubato를 설치하고 검증한다' \
        '  --only-shell            셸 alias 블록과 cmux 세션 복원만 다시 심는다'
      exit 0 ;;
    *) printf '모르는 옵션: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
head_() { printf '\n%s== %s ==%s\n' "$BOLD" "$1" "$RST"; }
ok()    { printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YEL" "$RST" "$1"; }
err()   { printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
say()   { printf '  %s\n' "$1"; }
plan()  { printf '    %s[계획]%s %s\n' "$DIM" "$RST" "$1"; }

MANUAL=()
add_manual() { MANUAL+=("$1"); }

# ---------------------------------------------------------------- 도구 찾기

# 기본 node 를 바꾸지 않는다. 24+ 를 찾아 그것만 쓴다.
find_node24() {
  local bin ver major best=""
  for bin in "${HOME}/.nvm/versions/node"/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node \
             "$(command -v node 2>/dev/null || true)"; do
    [ -n "$bin" ] && [ -x "$bin" ] || continue
    ver="$("$bin" -v 2>/dev/null || true)"; major="${ver#v}"; major="${major%%.*}"
    [ -n "$major" ] || continue
    if [ "$major" -ge 24 ] 2>/dev/null; then best="$bin"; [ "$major" -eq 24 ] && break; fi
  done
  [ -n "$best" ] && printf '%s' "$best"
}

# 루트는 bun 워크스페이스(`workspace:*`)라 npm 으로는 못 깐다.
# 확장 빌드도 bun 1.4+ 를 요구한다 — 그 아래는 `--metafile` 이 없다.
find_bun() {
  local bin ver major minor
  for bin in "${HOME}/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun \
             "$(command -v bun 2>/dev/null || true)"; do
    [ -n "$bin" ] && [ -x "$bin" ] || continue
    ver="$("$bin" --version 2>/dev/null || true)"
    major="${ver%%.*}"; minor="${ver#*.}"; minor="${minor%%.*}"
    [ -n "$major" ] || continue
    if [ "$major" -gt 1 ] 2>/dev/null || { [ "$major" -eq 1 ] && [ "${minor:-0}" -ge 4 ]; } 2>/dev/null; then
      printf '%s' "$bin"; return 0
    fi
  done
  return 1
}

find_uv() {
  local bin
  for bin in "${HOME}/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv \
             "$(command -v uv 2>/dev/null || true)"; do
    [ -n "$bin" ] && [ -x "$bin" ] || continue
    printf '%s' "$bin"; return 0
  done
  return 1
}

# 로그인 셸의 rc 파일. zsh 가 아니어도 맞는 자리에 쓴다.
shell_rc() {
  case "${SHELL##*/}" in
    zsh)  printf '%s' "$HOME/.zshrc" ;;
    bash) [ -f "$HOME/.bash_profile" ] && printf '%s' "$HOME/.bash_profile" || printf '%s' "$HOME/.bashrc" ;;
    *)    printf '%s' "$HOME/.profile" ;;
  esac
}

head_ "단계 0 · 사전 점검"
[ "$APPLY" -eq 1 ] || warn "dry-run 이다. 아무것도 바뀌지 않는다 (적용: ./install.sh --apply)"

NODE24="$(find_node24)"
if [ -n "$NODE24" ]; then ok "Node 24+ : $NODE24 ($("$NODE24" -v))"
else err "Node 24+ 가 없다"; add_manual "nvm install 24 또는 brew install node@24"; fi

BUN="$(find_bun || true)"
if [ -n "$BUN" ]; then ok "bun 1.4+ : $BUN ($("$BUN" --version))"
else err "bun 1.4+ 가 없다"; add_manual "curl -fsSL https://bun.sh/install | bash"; fi

UV="$(find_uv || true)"
if [ "$ONLY_SHELL" -eq 1 ]; then
  : # 셸만 갱신할 때는 Python 도구를 요구하지 않는다.
elif [ -n "$UV" ]; then ok "uv : $UV ($("$UV" --version))"
else say "uv 없음 (msearch venv 를 새로 만들 때만 필요)"; fi


if [ -z "$NODE24" ] || [ -z "$BUN" ]; then
  err "필수 도구가 없어 여기서 멈춘다"
  printf '\n%s== 남은 일 ==%s\n' "$BOLD" "$RST"
  for m in "${MANUAL[@]}"; do say "- $m"; done
  exit 1
fi

PATH="$(dirname "$NODE24"):$PATH"

# 첫 설치와 재설치 모두 옛 사용자 상태와 현재 프로젝트 설정을 Rubato 경로로
# 옮긴다. dry-run에서는 계획만 보여준다.
if [ "$APPLY" -eq 0 ]; then
  plan "~/.omo와 현재 프로젝트 .omo를 .rubato로 충돌 없이 이관"
else
  "$NODE24" "$HARNESS/scripts/migrate-rubato-state.mjs" --cwd "$PWD" \
    || { err "기존 설정 경로 이관 실패"; exit 1; }
fi

# --only-shell 이면 의존성·프롬프트·스킬은 손대지 않는다. 셸 설정만 다시 심는다.
if [ "$ONLY_SHELL" -eq 0 ]; then

head_ "단계 1 · 의존성"
if [ "$APPLY" -eq 0 ]; then
  plan "bun install                        (엔진 senpi, 워크스페이스)"
  plan "npm install --prefix harness/rubato-pi"
else
  say "엔진을 깐다 (bun)"
  (cd "$REPO" && "$BUN" install) || { err "bun install 실패"; exit 1; }
  say "rubato-pi 를 깐다"
  npm install --prefix "$HARNESS/rubato-pi" >/dev/null 2>&1 || { err "rubato-pi 설치 실패"; exit 1; }
  say "Rubato 엔진 확장을 빌드한다"
  (cd "$REPO" && "$NODE24" "$HARNESS/scripts/build-engine.mjs" --force) \
    >/dev/null 2>&1 || { err "엔진 확장 빌드 실패"; exit 1; }
  "$NODE24" "$HARNESS/scripts/build-engine.mjs" --check >/dev/null 2>&1 \
    || { err "엔진 확장 산출물이 소스와 맞지 않는다"; exit 1; }
  ok "의존성 설치 완료"
fi

head_ "단계 2 · 역할별 시스템 프롬프트"
# 생성물(.build/)은 커밋하지 않으므로 clone 만으로는 없다.
if [ "$APPLY" -eq 0 ]; then
  plan "harness/prompts/build.sh 로 lead / teammate 프롬프트 합성"
  plan "~/.agents/rubato → harness/prompts 심링크"
else
  "$HARNESS/prompts/build.sh" >/dev/null || { err "프롬프트 합성 실패"; exit 1; }
  ok "프롬프트 합성"
  mkdir -p "$HOME/.agents"
  DEST="$HOME/.agents/rubato"
  if [ -L "$DEST" ]; then
    [ "$(readlink "$DEST")" = "$HARNESS/prompts" ] && ok "심링크 이미 맞다" \
      || { rm "$DEST"; ln -s "$HARNESS/prompts" "$DEST"; ok "심링크를 이 클론으로 바꿨다"; }
  elif [ -e "$DEST" ]; then
    err "~/.agents/rubato 가 심링크가 아니다. 기존 파일을 보존하려고 멈춘다"
    say "기존 경로를 직접 백업하거나 치운 뒤 다시 실행해라: $DEST"
    exit 1
  else
    ln -s "$HARNESS/prompts" "$DEST"; ok "~/.agents/rubato → harness/prompts"
  fi
fi

head_ "단계 3 · 스킬"
if [ "$APPLY" -eq 0 ]; then
  plan "harness/scripts/install-skills.sh  (번들 → ~/.agents/skills, 있는 것은 유지)"
else
  "$HARNESS/scripts/install-skills.sh" || { err "스킬 설치 실패"; exit 1; }
  for skill in dispatching dispatched; do
    if ! cmp -s "$HARNESS/skills/$skill/SKILL.md" "$HOME/.agents/skills/$skill/SKILL.md"; then
      err "필수 스킬이 번들과 다르다: $skill"
      say "기존 파일을 보존하려고 멈췄다. 확인 후 이 명령으로 Rubato 번들을 설치해라:"
      say "  $HARNESS/scripts/install-skills.sh --force"
      exit 1
    fi
  done
  ok "필수 계약 스킬 확인"
fi

head_ "단계 3.5 · 확장"
# senpi 가 agentDir/extensions 를 훑어 자동으로 불러오는 사용자 확장이다.
# harness/rubato-pi/src/extensions/ 의 것들과 다르다 — 저쪽은 launch.mjs 가
# 경로를 직접 지정해 실어 넣는 하네스 부품이라 설치라는 단계가 없다.
if [ "$APPLY" -eq 0 ]; then
  plan "harness/scripts/install-extensions.sh  (번들 → agentDir/extensions, 있는 것은 유지)"
else
  "$HARNESS/scripts/install-extensions.sh" >/dev/null || { err "확장 설치 실패"; exit 1; }
  ok "번들 확장"
fi

fi   # ONLY_SHELL 스킵 끝

head_ "단계 4 · alias"
RC="$(shell_rc)"

# alias 는 낱개로 관리하지 않고 마커로 둔 블록을 통째 갈아끼운다.
# 낱개로 넣으면 alias 를 하나 늘릴 때마다 기존 사용자에게는 그게 안 간다.
# 블록이면 무엇이 늘고 줄었든 한 번에 맞춰진다.
ALIAS_BEGIN="# >>> rubato aliases >>>"
ALIAS_END="# <<< rubato aliases <<<"

rubato_alias_block() {
  cat <<EOF
$ALIAS_BEGIN
# 이 블록은 install.sh 가 관리한다. 손으로 고쳐도 다음 설치에 덮인다.
RUBATO_HARNESS="$HARNESS"
alias rubato="\$RUBATO_HARNESS/scripts/rubato-pi.sh"
alias rubato-pi="\$RUBATO_HARNESS/scripts/rubato-pi.sh"
# 역할별 프롬프트 조립 없이 Documents/SOUL.md 만 시스템 프롬프트로.
alias rubato-soul="\$RUBATO_HARNESS/scripts/rubato-soul.sh"
# msearch — 기억 검색. alias 는 사람이 쓰는 대화형 셸용이고,
# 에이전트가 부르는 비대화형 bash 는 rc 를 안 읽으므로 ~/.local/bin 심링크가 정본이다.
alias msearch="\$RUBATO_HARNESS/msearch/msearch"
# dispatch — 비대화 워커. alias 는 대화형 셸용이고, 에이전트 bash 는
# ~/.local/bin/dispatch 심링크가 정본이다.
alias dispatch="\$RUBATO_HARNESS/scripts/rubato-dispatch.sh"
$ALIAS_END
EOF
}

if [ "$APPLY" -eq 0 ]; then
  plan "$RC 에 alias 블록을 넣는다 (rubato, rubato-pi, rubato-soul, msearch, dispatch)"
  plan "이미 있으면 블록을 이 클론으로 갈아끼운다"
else
  touch "$RC"
  NEW_BLOCK="$(rubato_alias_block)"

  if grep -qF "$ALIAS_BEGIN" "$RC" 2>/dev/null; then
    CUR_BLOCK="$(sed -n "/^# >>> rubato aliases >>>$/,/^# <<< rubato aliases <<<$/p" "$RC")"
    if [ "$CUR_BLOCK" = "$NEW_BLOCK" ]; then
      ok "alias 블록 이미 맞다"
    else
      # 블록만 도려낸다. 그 밖의 rc 내용은 손대지 않는다.
      tmp="$(mktemp)"
      sed "/^# >>> rubato aliases >>>$/,/^# <<< rubato aliases <<<$/d" "$RC" > "$tmp"
      printf '%s\n' "$NEW_BLOCK" >> "$tmp"
      mv "$tmp" "$RC"
      ok "alias 블록을 이 클론으로 갈았다 ($RC)"
    fi
  else
    # 마커 이전에 손으로/옛 설치기로 넣은 낱개 줄이 있으면 거둔다.
    # 안 거두면 나중에 정의된 옛 줄이 블록을 이긴다.
    # rubato-restart/rbr 는 삭제된 bridge 재기동 alias 다. 남아 있으면 여기서 걷어낸다.
    if grep -qE '^alias (rubato|rubato-pi|rubato-soul|rubato-restart|rbr|msearch|dispatch)=' "$RC" 2>/dev/null; then
      tmp="$(mktemp)"
      grep -vE '^alias (rubato|rubato-pi|rubato-soul|rubato-restart|rbr|msearch|dispatch)=' "$RC" > "$tmp"
      mv "$tmp" "$RC"
      say "옛 alias 줄을 거두고 블록으로 옮겼다"
    fi
    printf '\n%s\n' "$NEW_BLOCK" >> "$RC"
    ok "alias 블록을 넣었다 ($RC)"
  fi
  add_manual "새 셸을 열거나 'source $RC' 해야 alias 가 먹는다"
fi

head_ "단계 4.2 · msearch·dispatch 를 PATH 에"
# alias 는 대화형 셸에서만 산다. 에이전트가 도구로 부르는 bash 는 비대화형이라
# rc 를 안 읽어서 alias 가 없다 — 프롬프트는 msearch 로 기억을 찾으라고 지시하는데
# 정작 그 명령이 없는 상태가 오래 갔다. 심링크가 그 구멍을 막는다.
# dispatch 도 같다. 정본은 rubato dispatch 이고, PATH 이름은 같은 스크립트다.
MSEARCH_LINK="$HOME/.local/bin/msearch"
MSEARCH_SRC="$HARNESS/msearch/msearch"
DISPATCH_LINK="$HOME/.local/bin/dispatch"
DISPATCH_SRC="$HARNESS/scripts/rubato-dispatch.sh"
if [ "$APPLY" -eq 0 ]; then
  plan "$MSEARCH_LINK -> $MSEARCH_SRC 심링크를 만든다"
  plan "$DISPATCH_LINK -> $DISPATCH_SRC 심링크를 만든다"
else
  mkdir -p "$HOME/.local/bin"
  if [ "$(readlink "$MSEARCH_LINK" 2>/dev/null)" = "$MSEARCH_SRC" ]; then
    ok "msearch 심링크 이미 맞다"
  else
    ln -sf "$MSEARCH_SRC" "$MSEARCH_LINK"
    ok "msearch 를 PATH 에 놓았다 ($MSEARCH_LINK)"
  fi
  if [ "$(readlink "$DISPATCH_LINK" 2>/dev/null)" = "$DISPATCH_SRC" ]; then
    ok "dispatch 심링크 이미 맞다"
  else
    ln -sf "$DISPATCH_SRC" "$DISPATCH_LINK"
    ok "dispatch 를 PATH 에 놓았다 ($DISPATCH_LINK)"
  fi
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) add_manual "~/.local/bin 이 PATH 에 없다. rc 에 추가해야 msearch·dispatch 가 잡힌다" ;;
  esac
fi

if [ "$ONLY_SHELL" -eq 0 ]; then

head_ "단계 4.3 · msearch 파이썬 환경"
# 4.2 의 심링크는 명령을 PATH 에 놓을 뿐이다. msearch 는 redis/dotenv/openai/konlpy
# 위에서 돌기 때문에, 심링크만 걸어 두면 "명령은 있는데 첫 줄에서 죽는" 상태가 된다 —
# 절반만 설치된 그 상태가 실제로 한 머신에서 오래 갔다.
# 최근 배포판의 시스템 파이썬은 PEP 668 로 전역 설치를 막으므로(EXTERNALLY-MANAGED)
# 전역 pip 를 강행하지 않고 msearch 옆에 잠긴 venv 를 원자적으로 세운다. 설치가
# 중간에 끊겨도 완성 전 venv 는 런처가 볼 수 없다.
MSEARCH_VENV="$HARNESS/msearch/.venv"
MSEARCH_LOCK="$HARNESS/msearch/requirements.lock"
msearch_env_ok() { "$1" "$HARNESS/msearch/msearch_env.py" >/dev/null 2>&1; }

if [ -x "$MSEARCH_VENV/bin/python" ] && msearch_env_ok "$MSEARCH_VENV/bin/python"; then
  ok "msearch venv 가 잠금과 맞다 ($MSEARCH_VENV)"
elif [ "$APPLY" -eq 0 ]; then
  plan "runtime.lock의 Python으로 $MSEARCH_LOCK 그대로 venv 를 세운다"
else
  MSEARCH_VENV_TMP="$(mktemp -d "$HARNESS/msearch/.venv.tmp.XXXXXX")"
  MSEARCH_PYTHON_VERSION="$(awk -F= '$1 == "PYTHON_VERSION" { print $2 }' "$HARNESS/msearch/runtime.lock")"
  # 실패를 조용히 삼키지 않는다. 한 머신에서 uv 가 20개월 묵어 --managed-python 을
  # 모르는 바람에 venv 가 안 서는데, warn 한 줄만 남아 아무도 원인을 못 찾았다.
  # 그 사이 검색은 이틀 넘게 죽어 있었다. 에러 원문을 그대로 보여준다.
  MSEARCH_SETUP_LOG="$(mktemp "${TMPDIR:-/tmp}/msearch-setup.XXXXXX")"
  if [ -n "$UV" ] &&
     "$UV" venv --python "$MSEARCH_PYTHON_VERSION" --managed-python --seed "$MSEARCH_VENV_TMP" >>"$MSEARCH_SETUP_LOG" 2>&1 &&
     "$UV" pip install --python "$MSEARCH_VENV_TMP/bin/python" -q -r "$MSEARCH_LOCK" >>"$MSEARCH_SETUP_LOG" 2>&1 &&
     msearch_env_ok "$MSEARCH_VENV_TMP/bin/python"; then
    rm -rf "$MSEARCH_VENV"
    mv "$MSEARCH_VENV_TMP" "$MSEARCH_VENV"
    rm -f "$MSEARCH_SETUP_LOG"
    ok "msearch venv 를 잠금대로 세웠다 ($MSEARCH_VENV)"
  else
    rm -rf "$MSEARCH_VENV_TMP"
    warn "msearch venv 를 못 세웠다"
    if [ -s "$MSEARCH_SETUP_LOG" ]; then
      tail -n 5 "$MSEARCH_SETUP_LOG" | sed 's/^/      /'
    fi
    if [ -z "$UV" ]; then
      add_manual "uv 설치: curl -LsSf https://astral.sh/uv/install.sh | sh"
    elif grep -q 'managed-python' "$MSEARCH_SETUP_LOG" 2>/dev/null; then
      add_manual "uv 가 낡았다: uv self update 후 다시 실행: ./install.sh --apply"
    else
      add_manual "harness/msearch/runtime.lock을 확인한 뒤 다시 실행: ./install.sh --apply"
    fi
    rm -f "$MSEARCH_SETUP_LOG"
  fi
fi

# 검색 백엔드(Redis Stack, OPENAI_API_KEY)는 이 설치기가 세우지 않는다. 상태 판정은
# doctor 한 곳에만 두고 여기서는 가리키기만 한다 — 판정이 두 곳에 있으면 갈린다.
say "백엔드(Redis Stack · OPENAI_API_KEY)는 msearch --doctor 로 본다"

fi   # ONLY_SHELL 의존성 스킵 끝

head_ "단계 4.5 · cmux 세션 복원 (선택)"
# cmux 는 터미널 안의 코딩 에이전트를 감지해 앱을 다시 띄울 때 세션을 이어붙인다.
# rubato 는 `node .../rubato-pi.mjs` 로 떠고 세션도 ~/.rubato-pi 에 쌓여서
# 기본 감지에 안 걸린다. 둘 다 Vault 에 명시해야 맞는다.
# cmux.json 은 JSONC 라 쓰면 주석을 잃는다. 그래서 백업을 남긴다.
if [ ! -f "$HOME/.config/cmux/cmux.json" ]; then
  say "cmux 를 안 쓴다. 건너륐다"
elif [ "$APPLY" -eq 0 ]; then
  plan "cmux Vault 에 rubato 를 등록한다 (백업을 남긴다)"
else
  VAULT_OUT="$(node "$HARNESS/scripts/cmux-vault.mjs" --apply 2>/dev/null || true)"
  case "$VAULT_OUT" in
    *"백업: "*)
      ok "cmux 세션 복원 — 재시작해도 세션이 돌아온다"
      say "  ${DIM}백업 ${VAULT_OUT##*백업: }${RST}"
      add_manual "cmux 설정을 반영하려면: cmux reload-config" ;;
    *"이미 맞다"*) ok "cmux Vault 에 rubato 가 이미 있다" ;;
    *) warn "cmux Vault 등록을 건너뛰었다 (cmux config doctor 로 확인해라)" ;;
  esac
fi

if [ "$ONLY_SHELL" -eq 0 ]; then

head_ "단계 5 · 크레덴셜 (읽기만 한다)"
CRED_OK=1
[ -f "$HOME/.senpi/agent/auth.json" ] && ok "xAI — ~/.senpi/agent/auth.json" \
  || { warn "xAI OAuth 가 없다"; CRED_OK=0; add_manual "xAI 로그인이 필요하다"; }
# Claude 는 1년짜리 장기 setup-token 이다(sk-ant-oat...). 직결 Anthropic 경로
# (`anthropic-setup-token.mjs`)는 파일을 먼저 보고 없으면 Keychain 으로 넘어간다.
# 계정 이름 기본값은 sub 이고 RUBATO_CLAUDE_ACCOUNT 로 바꾼다(예전 FX_ 이름도 읽는다).
CLAUDE_ACCOUNT="${RUBATO_CLAUDE_ACCOUNT:-${FX_CLAUDE_ACCOUNT:-sub}}"
if [ -f "$HOME/.claude/auth/setup-token-$CLAUDE_ACCOUNT" ]; then
  ok "Claude 장기 setup-token — ~/.claude/auth/setup-token-$CLAUDE_ACCOUNT"
elif security find-generic-password -s "Claude Code-setup-token-$CLAUDE_ACCOUNT" >/dev/null 2>&1; then
  ok "Claude 장기 setup-token — Keychain ($CLAUDE_ACCOUNT)"
else
  warn "Claude setup-token 이 없다 (계정: $CLAUDE_ACCOUNT)"
  CRED_OK=0
  add_manual "claude setup-token 으로 받아 ~/.claude/auth/setup-token-$CLAUDE_ACCOUNT 에 넣어라"
fi
# Codex 는 senpi auth.json 의 openai-codex OAuth 로 직접 간다.
if [ -f "$HOME/.senpi/agent/auth.json" ] && grep -q '"openai-codex"' "$HOME/.senpi/agent/auth.json" 2>/dev/null; then
  ok "Codex — ~/.senpi/agent/auth.json (openai-codex)"
else
  warn "Codex OAuth 가 없다"
  CRED_OK=0
  add_manual "Codex 로그인이 필요하다 (senpi auth.json 의 openai-codex)"
fi

head_ "단계 6 · 확인"
if [ "$APPLY" -eq 0 ]; then
  plan "비대화형으로 한 번 띄워 모델 왕복을 확인한다"
elif [ "$CRED_OK" -eq 0 ]; then
  warn "크레덴셜이 빠져 모델 호출을 확인하지 못한다"
  say "  설치 자체는 끝났다. 로그인 뒤 'rubato' 로 확인해라"
else
  say "비대화형으로 띄워 본다"
  probe="$(mktemp -d)"; (cd "$probe" && git init -q && echo x > a.md)
  out="$(cd "$probe" && "$HARNESS/scripts/rubato-pi.sh" --print "Say only: ok" 2>&1 | tail -1)"
  rm -rf "$probe"
  if [ "$out" = "ok" ]; then ok "비대화형 왕복 성공 (rubato --print)"
  else err "왕복 실패: $out"; add_manual "'rubato --print \"ok\"' 를 직접 돌려 원인을 봐라"; fi
fi

fi   # ONLY_SHELL 스킵 끝

head_ "요약"
if [ "$APPLY" -eq 0 ]; then
  say "계획만 보였다. 적용하려면: ./install.sh --apply"
else
  say "대화형은 'rubato', 비대화형은 'rubato --print \"...\"' 다."
fi
if [ "${#MANUAL[@]}" -gt 0 ]; then
  printf '\n%s남은 일%s\n' "$BOLD" "$RST"
  for m in "${MANUAL[@]}"; do say "- $m"; done
fi
exit 0
