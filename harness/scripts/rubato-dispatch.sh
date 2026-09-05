#!/usr/bin/env bash
# rubato dispatch — 브리프를 stdin으로 받아 비대화 워커를 한 번 돌린다.
# 엔진은 --print 를 쓰지만, 호출자 stdout은 잘린 답이다. 전문은 last.stdout.
# 부모 세션에서 rubato --print / rubato-pi.sh --print 를 직접 돌리지 말라.
set -euo pipefail

# 부모 컨텍스트로 날아가는 최대. 워커가 계약을 어겨도 여기서 자른다.
DEFAULT_STDOUT_MAX=8192

usage() {
  cat <<'USAGE'
Usage: rubato dispatch <name> [grok|grokfast|fast|muse|sol|fable|astra] [--model PROVIDER/MODEL[:THINKING]] [--effort LEVEL] [--cwd DIR] < brief.md
       rubato dispatch <name> --continue < followup.md

`dispatch` on PATH is the same command.
The full last answer stays in the worker session dir. Caller stdout is
capped (RUBATO_DISPATCH_STDOUT_MAX, default 8192 bytes).

--model takes a full id like anthropic/claude-fable-5-1 and wins over the alias.
--effort appends :LEVEL to the model unless it already has :suffix (senpi --model form).

Models:
  grok      xai/grok-4.6
  grokfast  cursor/cursor-grok-4.6-high-fast
  fast      cursor/gemini-3.8-flash
  muse      opencode/muse-spark-1.3-contributor-free
  sol       openai-codex/gpt-5.6-sol
  fable     anthropic/claude-fable-5-1
  astra     openai-codex/gpt-6-astra:medium
USAGE
}

resolve_script_dir() {
  local source="${BASH_SOURCE[0]}"
  while [[ -L "$source" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done
  cd -P "$(dirname "$source")" && pwd
}

alias_to_model() {
  case "$1" in
    grok) echo "xai/grok-4.6" ;;
    grokfast) echo "cursor/cursor-grok-4.6-high-fast" ;;
    fast) echo "cursor/gemini-3.8-flash" ;;
    muse) echo "opencode/muse-spark-1.3-contributor-free" ;;
    sol) echo "openai-codex/gpt-5.6-sol" ;;
    fable) echo "anthropic/claude-fable-5-1" ;;
    astra) echo "openai-codex/gpt-6-astra:medium" ;;
    *) return 1 ;;
  esac
}

resolve_agent_dir() {
  if [[ -n "${RUBATO_PI_CODING_AGENT_DIR:-}" ]]; then
    printf '%s\n' "$RUBATO_PI_CODING_AGENT_DIR"
    return
  fi
  if [[ -n "${SENPI_CODING_AGENT_DIR:-}" ]]; then
    printf '%s\n' "$SENPI_CODING_AGENT_DIR"
    return
  fi
  printf '%s\n' "${HOME}/.rubato-pi/agent"
}

emit_worker_stdout() {
  local out="$1"
  local log="$2"
  local max size
  max="${RUBATO_DISPATCH_STDOUT_MAX:-$DEFAULT_STDOUT_MAX}"
  if [[ ! "$max" =~ ^[1-9][0-9]*$ ]]; then
    max="$DEFAULT_STDOUT_MAX"
  fi
  size="$(wc -c <"$out" | tr -d '[:space:]')"
  if [[ "$size" -le "$max" ]]; then
    cat "$out"
    return
  fi
  head -c "$max" "$out"
  printf '\n\n[rubato dispatch] truncated %s bytes to %s. full: %s  log: %s\n' \
    "$size" "$max" "$out" "$log"
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

case "$1" in
  -h|--help)
    usage
    exit 0
    ;;
  -*)
    echo "rubato dispatch: first argument must be the worker name" >&2
    usage >&2
    exit 2
    ;;
esac

NAME="$1"
shift

if [[ ! "$NAME" =~ ^[A-Za-z0-9._-]+$ || "$NAME" == "." || "$NAME" == ".." ]]; then
  echo "rubato dispatch: invalid name: $NAME" >&2
  exit 2
fi

MODEL_ALIAS=""
MODEL_DIRECT=""
EFFORT=""
CWD=""
CONTINUE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue|-c)
      CONTINUE=1
      shift
      ;;
    --model)
      if [[ $# -lt 2 ]]; then
        echo "rubato dispatch: --model requires PROVIDER/MODEL[:THINKING]" >&2
        exit 2
      fi
      if [[ -n "$MODEL_DIRECT" ]]; then
        echo "rubato dispatch: model already set to $MODEL_DIRECT" >&2
        exit 2
      fi
      if [[ -n "$MODEL_ALIAS" ]]; then
        echo "rubato dispatch: model already set to $MODEL_ALIAS" >&2
        exit 2
      fi
      MODEL_DIRECT="$2"
      shift 2
      ;;
    --effort)
      if [[ $# -lt 2 ]]; then
        echo "rubato dispatch: --effort requires a level (e.g. low, medium, high)" >&2
        exit 2
      fi
      if [[ -n "$EFFORT" ]]; then
        echo "rubato dispatch: effort already set to $EFFORT" >&2
        exit 2
      fi
      EFFORT="$2"
      shift 2
      ;;
    --cwd)
      if [[ $# -lt 2 ]]; then
        echo "rubato dispatch: --cwd requires a directory" >&2
        exit 2
      fi
      CWD="$2"
      shift 2
      ;;
    grok|grokfast|fast|muse|sol|fable|astra)
      if [[ -n "$MODEL_ALIAS" ]]; then
        echo "rubato dispatch: model already set to $MODEL_ALIAS" >&2
        exit 2
      fi
      MODEL_ALIAS="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "rubato dispatch: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      echo "rubato dispatch: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

MODEL_ALIAS="${MODEL_ALIAS:-grok}"
if [[ -n "$MODEL_DIRECT" ]]; then
  MODEL="$MODEL_DIRECT"
else
  MODEL="$(alias_to_model "$MODEL_ALIAS")"
fi
if [[ -n "$EFFORT" ]]; then
  if [[ "$MODEL" != *:* ]]; then
    MODEL="$MODEL:$EFFORT"
  else
    echo "rubato dispatch: --effort ignored, model already has :suffix: $MODEL" >&2
  fi
fi

SCRIPT_DIR="$(resolve_script_dir)"
LAUNCHER="$SCRIPT_DIR/rubato-pi.sh"
AGENT_DIR="$(resolve_agent_dir)"
SESSION_DIR="$AGENT_DIR/dispatch/$NAME"
LOG="$SESSION_DIR/last.log"
OUT="$SESSION_DIR/last.stdout"

if [[ ! -x "$LAUNCHER" ]]; then
  echo "rubato dispatch: launcher not found: $LAUNCHER" >&2
  exit 127
fi

if [[ -n "$CWD" && ! -d "$CWD" ]]; then
  echo "rubato dispatch: cwd does not exist: $CWD" >&2
  exit 2
fi

mkdir -p "$SESSION_DIR"

cmd=("$LAUNCHER" --print --session-dir "$SESSION_DIR" --name "$NAME")
if [[ "$CONTINUE" -eq 1 ]]; then
  cmd+=(--continue)
else
  cmd+=(--model "$MODEL")
fi

status=0
if [[ -n "$CWD" ]]; then
  (cd "$CWD" && "${cmd[@]}") >"$OUT" 2>"$LOG" || status=$?
else
  "${cmd[@]}" >"$OUT" 2>"$LOG" || status=$?
fi

emit_worker_stdout "$OUT" "$LOG"
exit "$status"
