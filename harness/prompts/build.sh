#!/bin/bash
# rubato 시스템 프롬프트 합성.
#
# 정본은 이 폴더다. ~/.agents/rubato 는 여기를 가리키는 심링크다.
# 산출물 .build/*.md 는 통째 주입되므로 역할마다 완결된 파일 하나여야 한다.
# 고칠 때는 조각을 고치고 여기를 다시 돌린다. 클론한 사람은 한 번 돌리면 된다.
#
# 조각이 `.pi.md` 인 것은 이 프롬프트가 rubato-pi(Senpi 엔진) 전용이기 때문이다.
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

# 시스템 프롬프트 = 프리앰블 + 공통 운영 계약 + 역할 + 평온함 + 말투.
#
# 프리앰블은 맨 앞이다. 이름을 주고 환영하는 자리라 규칙보다 먼저 와야 한다.
# 대화 맨 앞에 끼우는 모델 턴(opening-turn.pi.md)은 여기 합치지 않는다. 그건
# 시스템 프롬프트가 아니라 대화 기록의 첫 턴이고, 역할 프롬프트 확장이 원문 그대로 읽는다.
#
# 말투가 마지막인 것은 의도다. 앞의 영어 산문에 눌리지 않아야 하기 때문이다.
# 평온함 문구는 답에 가장 가까운 자리에 두고 싶지만 그 자리는 말투 몫이라 바로 앞에 둔다.
#
# 말투 조각은 한 벌이다. 말하는 방식 자체는 역할을 타지 않기 때문이고, 역할마다
# 달라지는 보고 계약은 core-*.pi.md 가 이미 갖고 있다. 둘로 나눠 두면 같은 문장
# 규칙을 두 곳에서 고쳐야 해서 한쪽만 낙후된다.
#
# 브리프를 주고받는 계약은 brief-exchange 한 곳에 두고 세 파일이 모두 싣는다.
# 역할 조각에는 그 역할에만 해당하는 문장만 둔다.
# owner 와 verifier 는 같은 teammate 파일을 쓴다. 검증도 하나의 워크스트림이고,
# verifier 는 산출물이 판단인 owner 이기 때문이다. 순수 task Agent 는 agent 파일을 쓴다.
for role in lead teammate agent; do
  parts=(preamble.pi.md base.pi.md brief-exchange.pi.md "core-$role.pi.md" calm.pi.md voice.md)
  if ! fresh "$OUT/$role.pi.md" "${parts[@]}"; then
    emit "$role.pi.md" "${parts[@]}"
  fi
done
