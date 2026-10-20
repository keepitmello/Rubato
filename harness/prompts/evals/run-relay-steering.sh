#!/bin/bash
# relay-steering.yaml 을 돌린다. 사람이 채점할 답을 파일로 남긴다.
#
#   run-relay-steering.sh <prompts 폴더> <출력 폴더> [모델] [판 수]
#
# 프롬프트는 실제 로더(system-prompt.mjs loadRolePrompt)로 조립한다. 그래서 세뇨는
# 그 사람 집의 조각까지 들어간 프롬프트로 돈다. 고치기 전과 후를 비교하려면
# 고치기 전 prompts 폴더를 복사해 두고 두 폴더로 한 번씩 돌린다.
# 리드 프롬프트는 .build/lead.pi.md 를 읽으니 고친 쪽은 build.sh 를 먼저 돌린다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROMPTS="$(cd "$1" && pwd)"; OUT="$2"; MODEL="${3:-anthropic/claude-opus-5-5}"; TRIALS="${4:-3}"
LOADER="$HERE/../../rubato-pi/src/system-prompt.mjs"
mkdir -p "$OUT"

python3 - "$HERE/relay-steering.yaml" "$OUT" <<'EOF'
import sys, yaml, os
suite = yaml.safe_load(open(sys.argv[1]))
for c in suite["cases"]:
    open(os.path.join(sys.argv[2], c["id"] + ".role"), "w").write(c["role"])
    open(os.path.join(sys.argv[2], c["id"] + ".msg"), "w").write(c["state"].strip() + "\n\n" + c["user"].strip())
EOF

for role in lead companion; do
  node --input-type=module -e "
    import { loadRolePrompt } from '$LOADER';
    process.stdout.write(loadRolePrompt('$role', { env: { ...process.env, RUBATO_PROMPTS_DIR: '$PROMPTS' } }));
  " > "$OUT/system-$role.md"
done

for msg in "$OUT"/*.msg; do
  id="$(basename "$msg" .msg)"; role="$(cat "$OUT/$id.role")"
  for n in $(seq 1 "$TRIALS"); do
    rubato -p --no-tools --no-session --no-skills --no-context-files --no-extensions \
      --model "$MODEL" --thinking high \
      --system-prompt "$(cat "$OUT/system-$role.md")" "$(cat "$msg")" \
      > "$OUT/$id.$n.txt" 2> "$OUT/$id.$n.err" &
  done
done
wait
echo "wrote $OUT"
