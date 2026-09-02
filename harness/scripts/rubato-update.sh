#!/bin/sh
# Rubato 업데이트. 원격에 새 커밋이 있으면 받아서 필요한 것만 다시 만든다.
#
#   rubato-update.sh            대화형. 무엇이 바뀌었는지 보여주고 물어본다
#   rubato-update.sh --check    새 커밋이 있는지만 본다 (fetch 안 한다, 캐시 사용)
#   rubato-update.sh --yes      묻지 않고 전부 한다
#
# 종료 코드: 0 = 최신이거나 성공, 10 = 업데이트 있음(--check), 그 외 = 실패
set -eu

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO="$(CDPATH= cd -- "$HERE/../.." && pwd)"
HARNESS="$REPO/harness"
BRANCH="rubato/base"
STAMP="$HOME/.rubato-pi/last-update-check"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RST" "$1"; }
err()  { printf '  %s✗%s %s\n' "$RED" "$RST" "$1" >&2; }
fail() { err "$1"; exit 1; }

MODE=interactive
case "${1-}" in
  --check) MODE=check ;;
  --yes|-y) MODE=yes ;;
  "") ;;
  *) echo "쓰는 법: rubato-update.sh [--check|--yes]" >&2; exit 2 ;;
esac

# `rubato update` 자체도 설정 이관 진입점이다. 매 세션의 조용한 --check는
# 파일을 건드리지 않고, 실제 업데이트 명령에서만 옮긴다.
if [ "$MODE" != check ] && [ -f "$HERE/migrate-rubato-state.mjs" ]; then
  . "$HERE/find-node.sh"
  MIGRATION_NODE="$(rubato_find_node)" || fail "설정 경로를 옮기려면 Node.js 24+가 필요합니다."
  "$MIGRATION_NODE" "$HERE/migrate-rubato-state.mjs" --cwd "$PWD" \
    || fail "기존 설정 경로를 안전하게 옮기지 못했습니다."
fi

cd "$REPO"

# 지금 브랜치가 rubato/base 가 아니면 건드리지 않는다. 남의 작업 위에 pull 하지 않는다.
CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [ "$CURRENT" != "$BRANCH" ]; then
  [ "$MODE" = check ] && exit 0
  warn "지금 브랜치가 $CURRENT 입니다. $BRANCH 가 아니면 업데이트하지 않습니다."
  exit 0
fi

fetch_now() {
  git fetch --quiet origin "$BRANCH" 2>/dev/null || return 1
  mkdir -p "$(dirname "$STAMP")"
  date +%s > "$STAMP"
}

# --check 는 세션을 띄울 때마다 돌아서 매번 fetch 한다. 보통 0.5초.
#
# 느린 네트워크에서 세션 시작이 매달리면 안 된다. macOS 기본에는 timeout(1)
# 이 없어서 git 자체 레버로 끊는다 — 3초간 1KB/s 를 못 넘기면 포기한다.
# 포기해도 이미 받아 둔 원격 ref 로 비교만 하고 세션은 그대로 진행한다.
if [ "$MODE" = check ]; then
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=3 \
      fetch --quiet origin "$BRANCH" 2>/dev/null || true
  mkdir -p "$(dirname "$STAMP")"
  date +%s > "$STAMP"
else
  fetch_now || { err "원격을 받지 못했습니다. 네트워크를 확인해 주세요."; exit 1; }
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "$LOCAL")"

if [ "$LOCAL" = "$REMOTE" ]; then
  [ "$MODE" = check ] && exit 0
  ok "이미 최신입니다."
  exit 0
fi

# 뒤처져 있는지 확인. 앞서 있으면(로컬에만 커밋이 있으면) 손대지 않는다.
BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH")"
AHEAD="$(git rev-list --count "origin/$BRANCH..HEAD")"
if [ "$BEHIND" -eq 0 ]; then
  [ "$MODE" = check ] && exit 0
  ok "받을 것이 없습니다. 로컬이 $AHEAD 커밋 앞서 있습니다."
  exit 0
fi

if [ "$MODE" = check ]; then
  printf '%s✦ rubato 업데이트 %s개%s  %s`rubato update` 로 받으세요%s\n' \
    "$YEL" "$BEHIND" "$RST" "$DIM" "$RST" >&2
  exit 10
fi

# 무엇이 바뀌는지 보여준다.
printf '\n%s== 새 커밋 %s개 ==%s\n' "$BOLD" "$BEHIND" "$RST"
git log --oneline --no-decorate "HEAD..origin/$BRANCH" | sed 's/^/  /'

CHANGED="$(git diff --name-only "HEAD..origin/$BRANCH")"
need_deps=0; need_prompts=0; need_engine=0; need_shell=0; need_extensions=0
echo "$CHANGED" | grep -Eq '^(package\.json|bun\.lock|harness/rubato-pi/package\.json)$' && need_deps=1
echo "$CHANGED" | grep -Eq '^harness/prompts/' && need_prompts=1
# 자동 로드되는 사용자 확장. 설치기 자신이 바뀌어도 다시 깐다 — 설치 규칙이
# 바뀐 경우이므로 내용이 그대로여도 배치가 달라질 수 있다.
echo "$CHANGED" | grep -Eq '^(harness/extensions/|harness/scripts/install-extensions\.sh)' && need_extensions=1
# engine source뿐 아니라 조립 규칙 자체가 바뀌어도 다시 만든다. builder만 바뀐
# 업데이트를 건너뛰면 옛 manifest/import map을 신선하다고 오판한다.
echo "$CHANGED" | grep -Eq '^(packages/|harness/scripts/build-engine\.mjs$)' && need_engine=1
# 셸 설정은 alias 블록과 cmux Vault 등록이다. 둘 다 내 집(~/.zshrc, ~/.config/cmux)
# 을 고치는 일이라 소스를 받는 것만으로는 반영되지 않는다.
# install.sh 가 alias 목록을 들고 있고, scripts/ 에는 alias 가 가리키는 실체와
# Vault 등록기가 있다. 둘 중 하나라도 바뀌면 다시 심는다.
echo "$CHANGED" | grep -Eq '^(install\.sh$|harness/scripts/)' && need_shell=1
# Aside 면(aside-cursor 프록시)은 launchd 상주 프로세스라 소스를 받아도 옛 코드로
# 계속 돈다. 그 코드가 Aside models.json 잠금(모델 행·maxTokens)을 소유하고
# provider-direct 등 다른 모듈도 import 하므로, 업데이트마다 재시작한다.
# 이 기기에 등록돼 있을 때만.
need_aside=0
/bin/launchctl print "gui/$(id -u)/com.keepitmello.rubato.aside-cursor" >/dev/null 2>&1 && need_aside=1

printf '\n%s== 다시 만들 것 ==%s\n' "$BOLD" "$RST"
[ "$need_deps" = 1 ]    && echo "  의존성 설치"
[ "$need_prompts" = 1 ] && echo "  시스템 프롬프트 합성"
echo "  번들 스킬 → ~/.agents/skills"
[ "$need_extensions" = 1 ] && echo "  번들 확장 → agentDir/extensions"
[ "$need_shell" = 1 ]   && echo "  셸 alias 블록 · cmux 세션 복원"
[ "$need_engine" = 1 ]  && echo "  엔진 플러그인 빌드 ${DIM}(몇 분 걸려요)${RST}"
[ "$need_aside" = 1 ]   && echo "  Aside 프록시 재시작"
[ "$need_deps$need_prompts$need_extensions$need_engine$need_shell$need_aside" = "000000" ] && echo "  ${DIM}그 외는 소스만 받으면 돼요${RST}"

# 로컬 수정이 있어도 멈추지 않는다.
#
# 예전에는 dirty 면 그 자리에서 끝내고 사람에게 커밋/stash/버리기를 시켰다.
# 그런데 이 레포는 가만히 둬도 dirty 가 된다 — 엔진 산출물이 추적되는데
# rubato 는 세션마다 빌드를 돌렸고, 산출물 첫 줄의 소스 해시가 매번 달라졌다.
# 그래서 시키는 대로 정리해도 다음 세션에 또 걸렸다. 그 머신에서는 영구히
# 막히는 구조였고, 사람에게 떠넘기는 분기 자체가 잘못이었다.
#
# 산출물은 이제 레포 밖에서 만든다(harness/scripts/build-engine.mjs). 그래서
# 여기 남는 dirty 는 대개 진짜 사람 작업이다. 그것은 지키되, 업데이트는
# 실패시키지 않는다.
#
# `.rubato/evidence/` 는 판단에서 뺀다. 터미널 ANSI 캡처가 CRLF 인데
# .gitattributes 의 `*.txt text eol=lf` 가 LF 로 바꾸려 들어서 clone 만 해도
# 영구 dirty 상태를 만들 뿐 실행에는 쓰이지 않는 생성물이다.
DIRTY="$(git status --porcelain -- . ':(exclude).rubato/evidence' 2>/dev/null || true)"

# 받는 동안 사람 작업을 잠시 치웠는지. 어떻게 끝나든 되돌리기 위해 기록해 둔다.
STASHED=0
STASH_SHA=""
STASH_TAG="rubato-update pid=$$ ts=$(date +%s)"

# 우리가 방금 쌓은 항목만 고른다. 메시지 부분 문자열은 같은 초에 돌거나
# 사람이 비슷한 제목을 붙인 stash 와 겹친다. push 직후 refs/stash SHA 가 소유권이다.
remember_stash() {
  STASH_SHA="$(git rev-parse -q --verify refs/stash 2>/dev/null || true)"
  [ -n "$STASH_SHA" ] || return 1
  STASHED=1
}

find_our_stash() {
  [ -n "$STASH_SHA" ] || return 0
  git stash list --format='%gd %H' 2>/dev/null \
    | while IFS= read -r line; do
        ref="${line%% *}"
        hash="${line#* }"
        if [ "$hash" = "$STASH_SHA" ]; then
          printf '%s' "$ref"
          break
        fi
      done
}

restore_stash() {
  [ "$STASHED" = 1 ] || return 0
  STASHED=0

  REF="$(find_our_stash)"
  if [ -z "$REF" ]; then
    warn "치워둔 수정을 stash 에서 찾지 못했습니다. 직접 확인해 주세요."
    printf '    git stash list\n' >&2
    [ -n "$STASH_SHA" ] && printf '    git stash show -p %s   %s우리가 치운 커밋%s\n' "$STASH_SHA" "$DIM" "$RST" >&2
    return 1
  fi

  # --index 는 쓰지 않는다. 스테이징 상태까지 동시에 되돌리려다가 살짝만
  # 어긋나도 전체가 실패한다(git 스스로 "Try without --index" 를 권한다).
  # 여기서 지켜야 하는 것은 작업 내용이지 무엇을 add 해두느냐가 아니다.
  if git stash pop "$REF" >/dev/null 2>&1; then
    ok "작업하던 수정을 되돌렸습니다"
    return 0
  fi
  # pop 이 충돌하면 워킹트리는 unmerged 이고 stash 는 스택에 남는다.
  # 그 상태에서 다시 pop 하면 같은 패치를 한 번 더 얹는다. 고친 뒤 drop 한다.
  warn "수정을 되돌리는 중 충돌이 났습니다. 지금 워킹트리에서 정리하세요."
  printf '    git status\n' >&2
  printf '    git add -u\n' >&2
  printf '    git stash drop %s          %s%s / %s%s\n' "$REF" "$DIM" "$STASH_TAG" "$STASH_SHA" "$RST" >&2
  return 1
}
# 중단 신호를 받으면 치운 것을 되돌리고 **거기서 멈춘다**. 복원만 하고
# 리턴하면 사용자가 Ctrl-C 를 눌렀는데도 머지와 빌드가 그대로 굴러간다.
# 종료 코드는 신호 관례를 따른다(128 + 신호번호).
trap 'restore_stash >/dev/null 2>&1 || true; trap - INT;  exit 130' INT
trap 'restore_stash >/dev/null 2>&1 || true; trap - TERM; exit 143' TERM
trap 'restore_stash >/dev/null 2>&1 || true; trap - HUP;  exit 129' HUP
# 예상 못한 종료(set -e 로 죽는 경우 포함)에도 치운 것을 남기지 않는다.
# 성공 경로에서는 이미 restore_stash 가 돌아 STASHED 가 0 이라 아무 일도 없다.
trap 'restore_stash >/dev/null 2>&1 || true' EXIT

if [ "$MODE" != yes ]; then
  # tty 가 없으면(파이프, CI) 묻지 않고 빠진다. 매달리면 안 된다.
  if [ ! -r /dev/tty ] || [ ! -t 1 ]; then
    printf '\n  %s비대화 환경입니다. 받으려면: rubato update --yes%s\n' "$DIM" "$RST"
    exit 0
  fi
  printf '\n받을까요? [y/N] '
  read -r answer </dev/tty || answer=n
  case "$answer" in y|Y|yes|YES) ;; *) echo "  아무것도 하지 않았습니다."; exit 0 ;; esac
fi

printf '\n%s== 받는 중 ==%s\n' "$BOLD" "$RST"

# 수정이 있으면 먼저 그대로 받아 본다. 겹치지 않으면 git 이 알아서 통과시키고
# 사람 작업은 손도 대지 않은 채 남는다 — 치웠다 되돌리는 것보다 안전하다.
# 겹쳐서 거부당할 때만 잠시 치운다.
if [ -n "$DIRTY" ] && ! git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
  # pathspec 을 주지 않는다. `git stash push -- <경로>` 는 이미 스테이징된
  # 변경을 제대로 집지 못해서, 치운 줄 알았는데 실제로는 그대로 남고
  # 다음 merge 가 똑같이 거부당한다. 이 레포는 여러 세션이 같이 쓰고
  # 스테이징된 상태가 흔해서 정면으로 밟는다.
  if git stash push --include-untracked --message "$STASH_TAG" >/dev/null 2>&1; then
    if remember_stash; then
      ok "작업하던 수정을 잠시 치웠습니다"
    else
      err "치운 수정의 stash 를 확인하지 못했습니다. 업데이트를 중단합니다."
      exit 1
    fi
  fi
fi

if git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
  :
elif [ "$AHEAD" -gt 0 ]; then
  # --ff-only 는 로컬 전용 커밋이 있으면 절대 통과하지 않는다.
  # 사람 작업은 이미 치워 두었고, 커밋은 브랜치로 남겨 둔 다음
  # 체크아웃된 $BRANCH 만 origin 으로 옮긴다. reset --hard 가
  # 워킹트리를 origin 과 맞추는 가장 작은 프리미티브다 — rebase
  # 는 충돌을 만들고, merge 는 히스토리를 섞는다.
  if [ -n "$DIRTY" ] && [ "$STASHED" != 1 ]; then
    err "작업 중 수정을 치우지 못해 업데이트를 중단합니다."
    exit 1
  fi
  # DIRTY 판단에서 뺀 .rubato/evidence 는 reset --hard 가 지운다.
  # 사람 작업이 그것뿐이면 여기서 따로 치운다. DIRTY 가 비었으니
  # pathspec 없이 stash 해도 다른 사람 파일은 없다.
  if [ "$STASHED" != 1 ]; then
    EVIDENCE_DIRTY="$(git status --porcelain -- .rubato/evidence 2>/dev/null || true)"
    if [ -n "$EVIDENCE_DIRTY" ]; then
      if git stash push --include-untracked --message "$STASH_TAG" >/dev/null 2>&1 && remember_stash; then
        ok ".rubato/evidence 수정을 잠시 치웠습니다"
      else
        err ".rubato/evidence 수정을 지키지 못해 업데이트를 중단합니다."
        exit 1
      fi
    fi
  fi
  # 같은 초에 다른 rubato 세션도 업데이트할 수 있으므로 PID까지 붙인다.
  BACKUP="rubato/update-backup-$(date +%Y%m%d%H%M%S)-$$"
  if ! git branch "$BACKUP" HEAD >/dev/null 2>&1; then
    err "로컬 커밋을 백업하지 못했습니다. 업데이트를 중단합니다."
    restore_stash || true
    exit 1
  fi
  if ! git reset --hard "origin/$BRANCH" >/dev/null 2>&1; then
    err "원격을 적용하지 못했습니다. 로컬 HEAD 는 $BACKUP 에 있습니다."
    printf '    git reset --hard %s\n' "$BACKUP" >&2
    restore_stash || true
    exit 1
  fi
  warn "로컬 전용 커밋 $AHEAD 개를 $BACKUP 에 남겼습니다"
  printf '    git log --oneline origin/%s..%s\n' "$BRANCH" "$BACKUP" >&2
  printf '    git cherry-pick origin/%s..%s\n' "$BRANCH" "$BACKUP" >&2
else
  err "fast-forward 가 안 됩니다. 로컬에만 있는 커밋과 갈라졌을 수 있어요."
  printf '    %s갈라진 지점을 보려면: git log --oneline --graph HEAD origin/%s%s\n' \
    "$DIM" "$BRANCH" "$RST" >&2
  restore_stash || true
  exit 1
fi
ok "소스 $BEHIND 커밋"

# 되돌리는 것은 받자마자. 뒤에 오는 재빌드보다 먼저 해야 한다 — 재빌드가
# 건드리는 파일과 사람 작업이 겹치면 순서가 뒤바뀔 때 가짜 충돌이 난다.
# 충돌이면 재빌드와 완료 메시지를 내지 않는다. 워킹트리가 unmerged 인 채로
# bun/npm 이 돌면 사람 작업을 덮는다.
if ! restore_stash; then
  err "소스는 받았지만 치워 둔 수정을 되돌리지 못했습니다. 재빌드는 하지 않습니다."
  exit 1
fi

BUN="$(command -v bun || true)"
NODE="$(command -v node || true)"
NPM="$(command -v npm || true)"

if [ "$need_deps" = 1 ]; then
  [ -n "$BUN" ] || fail "bun 이 없어 엔진 의존성을 갱신할 수 없습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
  [ -n "$NPM" ] || fail "npm 이 없어 하네스 의존성을 갱신할 수 없습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
  (cd "$REPO" && "$BUN" install >/dev/null 2>&1) \
    && ok "엔진 의존성" || fail "bun install 에 실패했습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
  "$NPM" install --prefix "$HARNESS/rubato-pi" >/dev/null 2>&1 \
    && ok "rubato-pi 의존성" || fail "rubato-pi 의존성 설치에 실패했습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
fi

if [ "$need_engine" = 1 ]; then
  [ -n "$BUN" ] || fail "bun 이 없어 엔진을 빌드할 수 없습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
  [ -n "$NODE" ] || fail "node 가 없어 엔진을 빌드할 수 없습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
  printf '  %s… 엔진 빌드 중%s\n' "$DIM" "$RST"
  (cd "$REPO" && "$NODE" "$HARNESS/scripts/build-engine.mjs" --force >/dev/null 2>&1) \
    || fail "엔진 빌드에 실패했습니다. 손으로: node harness/scripts/build-engine.mjs --force"
  "$NODE" "$HARNESS/scripts/build-engine.mjs" --check >/dev/null 2>&1 \
    && ok "엔진 플러그인" || fail "엔진 산출물이 새 소스와 맞지 않습니다."
fi

if [ "$need_prompts" = 1 ]; then
  # .build 는 생성물이다. 소스 checkout 시각과 기존 생성물 시각만 비교하면
  # 시계 차이 때문에 낡은 판을 신선하다고 오판할 수 있으므로 강제로 다시 만든다.
  rm -f "$HARNESS/prompts/.build/lead.pi.md" "$HARNESS/prompts/.build/teammate.pi.md"
  "$HARNESS/prompts/build.sh" >/dev/null 2>&1 \
    || fail "시스템 프롬프트 합성에 실패했습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
  [ -s "$HARNESS/prompts/.build/lead.pi.md" ] && [ -s "$HARNESS/prompts/.build/teammate.pi.md" ] \
    && ok "시스템 프롬프트" || fail "시스템 프롬프트 산출물이 만들어지지 않았습니다."
fi

# 스킬은 받을 때마다 맞춘다. 설치본이 받기 전 번들과 같으면 갱신하고
# 로컬에서 고친 것은 둔다. 예전 설치기는 있는 스킬을 건너뛰어서, 내용이
# 이번 커밋에 없어도 여기서 한 번 더 맞춰야 낡은 설치본이 풀린다.
"$HARNESS/scripts/install-skills.sh" --sync-from "$LOCAL" \
  && ok "번들 스킬" || fail "번들 스킬 설치에 실패했습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."

# 확장은 덮어쓰지 않는다. 이 디렉터리는 Orca 가 심는 확장(orca-*.ts)과
# 사람이 손본 판이 같이 사는 자리라, 새 파일만 넣고 있는 것은 둔다.
if [ "$need_extensions" = 1 ]; then
  "$HARNESS/scripts/install-extensions.sh" >/dev/null 2>&1 \
    && ok "번들 확장" || fail "번들 확장 설치에 실패했습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
fi

# 셸 alias 블록. install.sh 가 정본이라 여기서 목록을 베끼지 않고 그걸 부른다.
# 규칙을 두 군데 두면 어깋난다. --apply 는 이미 맞으면 아무것도 안 한다.
if [ "$need_shell" = 1 ]; then
  if ! ALIAS_OUT="$("$REPO/install.sh" --apply --only-shell 2>&1)"; then
    printf '%s\n' "$ALIAS_OUT" >&2
    fail "셸 설정 갱신에 실패했습니다. 소스는 받았지만 업데이트는 완료되지 않았습니다."
  fi
  case "$ALIAS_OUT" in
    *"이미 맞다"*)  ok "셸 alias — 그대로" ;;
    *"alias 블록"*) ok "셸 alias 블록을 갱신했습니다 ${DIM}(새 셸부터)${RST}" ;;
    *)               warn "셸 alias 갱신 경고" ;;
  esac

  # cmux Vault — 등록 경로나 방식이 바뀜을 수 있다. 안 쓰면 조용히 빠진다.
  if [ -f "$HOME/.config/cmux/cmux.json" ]; then
    node "$HARNESS/scripts/cmux-vault.mjs" --apply >/dev/null 2>&1 \
      && ok "cmux 세션 복원" || warn "cmux Vault 경고"
  fi
fi

# cmux Vault — 세션 복원을 붙인다. 없으면 cmux 를 꺼다 켜는 순간 세션이
# 통째로 날아간다. 업데이트를 받기로 한 사람은 하네스가 자기 집을 고치는 것을
# 이미 허락했다 — 스킬과 프롬프트도 여기서 다시 깔린다.
# cmux.json 은 JSONC 라 쓰면 주석을 잃는다. 그래서 백업을 반드시 남긴다.
# Aside 프록시. 재시작하면 새 코드가 models.json 잠금을 다시 적용한다.
# 등록이 없는 기기(Aside 미사용)는 need_aside=0 이라 지나간다.
if [ "$need_aside" = 1 ]; then
  ASIDE_LABEL="com.keepitmello.rubato.aside-cursor"
  /bin/launchctl kickstart -k "gui/$(id -u)/$ASIDE_LABEL" >/dev/null 2>&1 \
    && ok "Aside 프록시 재시작" || warn "Aside 프록시 재시작 경고 — 손으로: launchctl kickstart -k gui/\$(id -u)/$ASIDE_LABEL"
fi

date +%s > "$STAMP"
printf '\n%s✓%s 업데이트를 마쳤습니다. %s다음 세션부터 적용돼요.%s\n\n' "$GRN" "$RST" "$DIM" "$RST"
