#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

bash -n "$repo/install.sh"
bash -n "$here/msearch"
python3 -m py_compile "$here/msearch_env.py" "$here/msearch_doctor.py"

# --only-shell은 Python 환경을 읽거나 쓰지 않는다. 전체 apply 대신 실행 흐름을
# 추적해 4.3 헤더와 venv 명령이 도달 불가능한지 고정한다.
trace="$(mktemp)"
trap 'rm -f "$trace"' EXIT
bash -x "$repo/install.sh" --only-shell > /dev/null 2>"$trace"
! grep -q '단계 4.3' "$trace" || fail '--only-shell reached msearch environment step'
! grep -q 'uv venv\|pip install' "$trace" || fail '--only-shell touched Python dependencies'

# 실행 파일만 남은 불완전 venv는 선택하지 않고 정상 전역 Python으로 내려간다.
sandbox="$(mktemp -d)"
trap 'rm -f "$trace"; rm -rf "$sandbox"' EXIT
cp "$here/msearch" "$here/msearch_env.py" "$here/runtime.lock" \
   "$here/requirements.lock" "$here/msearch_doctor.py" "$here/msearch_config.py" "$sandbox/"
mkdir -p "$sandbox/.venv/bin" "$sandbox/fakebin"
printf '#!/bin/sh\nexit 37\n' > "$sandbox/.venv/bin/python"
printf '#!/bin/sh\necho global-python-selected\n' > "$sandbox/fakebin/python3"
chmod +x "$sandbox/.venv/bin/python" "$sandbox/fakebin/python3"
result="$(PATH="$sandbox/fakebin:$PATH" "$sandbox/msearch" --doctor)"
[ "$result" = "global-python-selected" ] || fail 'broken venv outranked global Python'

# 잠금 검사를 통과한 venv는 전역 Python보다 먼저 쓴다.
cat > "$sandbox/.venv/bin/python" <<'EOF'
#!/bin/sh
case "$1" in
  *msearch_env.py) exit 0 ;;
esac
echo valid-venv-selected
EOF
chmod +x "$sandbox/.venv/bin/python"
result="$(PATH="$sandbox/fakebin:$PATH" "$sandbox/msearch" --doctor)"
[ "$result" = "valid-venv-selected" ] || fail 'valid locked venv was not selected'

# 잠금이 어긋난 Python으로는 실제 검색 경로에 진입하지 않고 doctor로 보낸다.
cat > "$sandbox/fakebin/python3" <<'EOF'
#!/bin/sh
case "$1" in
  *msearch_env.py) exit 1 ;;
  *msearch_doctor.py) echo mismatched-python-doctor ; exit 0 ;;
  *memory-index.py) echo INDEX-RAN-WITH-MISMATCHED-PYTHON ; exit 0 ;;
esac
exit 38
EOF
rm -rf "$sandbox/.venv"
result="$(PATH="$sandbox/fakebin:$PATH" "$sandbox/msearch" query 2>/dev/null)"
[ "$result" = "mismatched-python-doctor" ] || fail 'mismatched Python reached search runtime'
for option in --index --reindex; do
  result="$(PATH="$sandbox/fakebin:$PATH" "$sandbox/msearch" "$option" 2>/dev/null)"
  [ "$result" = "mismatched-python-doctor" ] || fail "mismatched Python reached $option runtime"
done

printf 'msearch runtime regression tests: PASS\n'
