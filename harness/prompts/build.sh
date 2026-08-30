#!/bin/bash
# rubato 시스템 프롬프트 합성.
#
# 정본은 이 폴더다. ~/.agents/rubato 는 여기를 가리키는 심링크일 뿐이다.
# 산출물 .build/*.md 는 통째 주입되므로 역할마다 완결된 파일 하나여야 한다.
# 고칠 때는 조각을 고치고 여기를 다시 돌린다. 클론한 사람은 한 번 돌리면 된다.
#
# 조각이 `.pi.md` 인 것은 이 프롬프트가 rubato-pi(Senpi 엔진) 전용이기 때문이다.
# 예전에는 fx 런타임용 조각이 따로 있었고 두 벌을 만들었다. fx 는 폐기했으므로
# pi 판만 남긴다. 이름의 `.pi` 는 계보를 남겨 두려고 유지한다.
#
# Claude Code 자세(~/.claude/tech-lead.md)와는 어떤 파일도 공유하지 않는다.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
OUT="$D/.build"
mkdir -p "$OUT"

# 헤더에 절대경로를 박지 않는다. 산출물은 시스템 프롬프트로 통 주입되므로
# 빌드한 머신에 따라 내용이 달라지면 같은 조각으로 만든 프롬프트가 서로 달라진다.
# 위치는 저장소 안에서 고정이라 상대경로로 충분하다.
# .build/ 는 gitignore 라 산출물 자체는 추적하지 않는다.
emit() {  # emit <산출파일명> <조각...>
  local out="$OUT/$1"; shift
  {
    echo "<!-- 생성물입니다. 고치지 마세요. 정본은 harness/prompts 의 조각들이고 build.sh 로 다시 만듭니다. -->"
    echo
    for f in "$@"; do
      [[ -f "$D/$f" ]] || { echo "build: 조각이 없습니다 - $D/$f" >&2; exit 1; }
      cat "$D/$f"
      echo
    done
  } > "$out"
  echo "wrote $out ($(wc -l < "$out" | tr -d ' ') lines)"
}

# 조각과 이 스크립트가 산출물보다 오래됐으면 다시 쓰지 않는다. 세션마다
# 돌리는데 내용은 거의 안 바뀌어서, 있을 때는 비교만 한다.
fresh() {
  local out="$1"; shift
  [[ -f "$out" ]] || return 1
  [[ "$0" -nt "$out" ]] && return 1
  for f in "$@"; do
    [[ -f "$D/$f" ]] || return 1
    [[ "$D/$f" -nt "$out" ]] && return 1
  done
  return 0
}

# 시스템 프롬프트 = 공통 운영 계약 + 역할 + 말투. 말투가 마지막인 것은 의도다. 앞의 영어
# 산문에 눌리지 않아야 하기 때문이다.
#
# 말투 조각은 한 벌이다. 말하는 방식 자체는 역할을 타지 않기 때문이고, 역할마다
# 달라지는 보고 계약은 core-*.pi.md 가 이미 갖고 있다. 둘로 나눠 두면 같은 문장
# 규칙을 두 곳에서 고쳐야 해서 한쪽만 낙후된다.
#
# 역할은 셋(lead/owner/verifier)이지만 core 파일은 둘이다. owner 와 verifier 는 같은
# teammate 파일을 쓴다. 검증도 하나의 워크스트림이고, verifier 는 산출물이 판단인
# owner 이기 때문이다. 둘을 가르는 것은 부팅 프롬프트가 아니라 받는 브리프다.
if ! fresh "$OUT/lead.pi.md" base.pi.md core-lead.pi.md voice.md; then
  emit lead.pi.md     base.pi.md core-lead.pi.md     voice.md
fi
if ! fresh "$OUT/teammate.pi.md" base.pi.md core-teammate.pi.md voice.md; then
  emit teammate.pi.md base.pi.md core-teammate.pi.md voice.md
fi
