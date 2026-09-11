#!/usr/bin/env bash
set -euo pipefail

profile="MoodyV7"; width=""; height=""; steps="8"; seed="0"; timeout="1800"; edit_speed="Quality"; identity_priority="Strict"
prompt=""; prompt_b64=""; input_image=""; target_scene=""; output_dir="$HOME/Downloads/krea2-windows"

usage() { printf '%s\n' "Usage: $0 (--prompt TEXT | --prompt-base64 BASE64) [--input-image IDENTITY_FILE] [--target-scene SCENE_FILE] [--edit-speed Quality|Fast] [--identity-priority Strict|Normal] [--profile MoodyV7|Stock] [--width N --height N] [--steps N] [--seed N] [--timeout N] [--output-dir DIR]"; }
while (($#)); do
  case "$1" in
    --prompt) prompt=${2-}; shift 2;; --prompt-base64) prompt_b64=${2-}; shift 2;;
    --profile) profile=${2-}; shift 2;; --width) width=${2-}; shift 2;;
    --height) height=${2-}; shift 2;; --steps) steps=${2-}; shift 2;;
    --seed) seed=${2-}; shift 2;; --timeout) timeout=${2-}; shift 2;;
    --input-image) input_image=${2-}; shift 2;; --edit-speed) edit_speed=${2-}; shift 2;;
    --target-scene) target_scene=${2-}; shift 2;;
    --identity-priority) identity_priority=${2-}; shift 2;;
    --output-dir) output_dir=${2-}; shift 2;; -h|--help) usage; exit 0;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2;;
  esac
done

if [[ -n "$prompt" && -n "$prompt_b64" ]] || [[ -z "$prompt" && -z "$prompt_b64" ]]; then printf '%s\n' 'Provide exactly one prompt input.' >&2; exit 2; fi
[[ "$profile" == "MoodyV7" || "$profile" == "Stock" ]] || { printf '%s\n' 'Invalid profile.' >&2; exit 2; }
if [[ -n "$width" || -n "$height" ]]; then
  [[ -n "$width" && -n "$height" ]] || { printf '%s\n' 'Provide both width and height or neither.' >&2; exit 2; }
fi
for pair in "steps:$steps:1:20" "seed:$seed:0:9223372036854775807" "timeout:$timeout:60:1800"; do
  IFS=: read -r name value minimum maximum <<<"$pair"
  [[ "$value" =~ ^[0-9]+$ ]] || { printf '%s must be an integer.\n' "$name" >&2; exit 2; }
  ((value >= minimum && value <= maximum)) || { printf '%s is out of range.\n' "$name" >&2; exit 2; }
done
if [[ -n "$width" ]]; then
  for pair in "width:$width:256:2048" "height:$height:256:2048"; do
    IFS=: read -r name value minimum maximum <<<"$pair"
    [[ "$value" =~ ^[0-9]+$ ]] || { printf '%s must be an integer.\n' "$name" >&2; exit 2; }
    ((value >= minimum && value <= maximum)) || { printf '%s is out of range.\n' "$name" >&2; exit 2; }
  done
  ((width % 8 == 0 && height % 8 == 0)) || { printf '%s\n' 'Dimensions must be divisible by 8.' >&2; exit 2; }
fi
[[ "$edit_speed" == "Quality" || "$edit_speed" == "Fast" ]] || { printf '%s\n' 'Invalid edit speed.' >&2; exit 2; }
[[ "$identity_priority" == "Strict" || "$identity_priority" == "Normal" ]] || { printf '%s\n' 'Invalid identity priority.' >&2; exit 2; }
if [[ -n "$input_image" ]]; then [[ -f "$input_image" ]] || { printf '%s\n' 'Input image does not exist.' >&2; exit 2; }; fi
if [[ -n "$target_scene" ]]; then
  [[ -n "$input_image" ]] || { printf '%s\n' '--target-scene requires --input-image.' >&2; exit 2; }
  [[ -f "$target_scene" ]] || { printf '%s\n' 'Target scene does not exist.' >&2; exit 2; }
fi

if [[ -n "$prompt" ]]; then prompt_b64=$(printf '%s' "$prompt" | base64 | tr -d '\r\n'); else printf '%s' "$prompt_b64" | base64 -D >/dev/null 2>&1 || { printf '%s\n' 'Invalid Base64 prompt.' >&2; exit 2; }; fi
wy-server ensure >/dev/null

remote_script='C:\Users\keepi\.codex\skills\krea2\scripts\invoke_krea2.ps1'
remote_input=""; remote_scene=""
if [[ -n "$input_image" ]]; then
  remote_name="krea2-i2i-$(python3 -c 'import uuid; print(uuid.uuid4().hex)').png"
  remote_input="C:\\AI\\Krea2\\remote-inputs\\$remote_name"
  ssh -o BatchMode=yes -o ConnectTimeout=8 wy-desktop powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force -Path 'C:\AI\Krea2\remote-inputs' | Out-Null"
  scp -q "$input_image" "wy-desktop:/C:/AI/Krea2/remote-inputs/$remote_name"
fi
if [[ -n "$target_scene" ]]; then
  scene_name="krea2-scene-$(python3 -c 'import uuid; print(uuid.uuid4().hex)').png"
  remote_scene="C:\\AI\\Krea2\\remote-inputs\\$scene_name"
  scp -q "$target_scene" "wy-desktop:/C:/AI/Krea2/remote-inputs/$scene_name"
fi
cleanup() {
  if [[ -n "$remote_input" ]]; then ssh -o BatchMode=yes -o ConnectTimeout=8 wy-desktop powershell.exe -NoProfile -Command "Remove-Item -LiteralPath '$remote_input' -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true; fi
  if [[ -n "$remote_scene" ]]; then ssh -o BatchMode=yes -o ConnectTimeout=8 wy-desktop powershell.exe -NoProfile -Command "Remove-Item -LiteralPath '$remote_scene' -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

args=(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$remote_script" -PromptBase64 "$prompt_b64" -Profile "$profile" -Steps "$steps" -Seed "$seed" -TimeoutSeconds "$timeout")
if [[ -n "$width" ]]; then args+=(-Width "$width" -Height "$height"); fi
if [[ -n "$remote_input" ]]; then args+=(-InputImage "$remote_input" -EditSpeed "$edit_speed" -IdentityPriority "$identity_priority"); fi
if [[ -n "$remote_scene" ]]; then args+=(-TargetSceneImage "$remote_scene"); fi
remote_json=$(ssh -o BatchMode=yes -o ConnectTimeout=8 wy-desktop "${args[@]}")
result=$(printf '%s\n' "$remote_json" | tail -n 1)
remote_file=$(RESULT_JSON="$result" python3 - <<'PY'
import json, os
r=json.loads(os.environ['RESULT_JSON'])
if r.get('status')!='success': raise SystemExit('Windows Krea2 failed: '+json.dumps(r,ensure_ascii=False))
print(r['output_file'])
PY
)
remote_sftp=$(REMOTE_FILE="$remote_file" python3 - <<'PY'
import os
p=os.environ['REMOTE_FILE'].replace('\\','/')
if len(p)<3 or p[1:3]!=':/': raise SystemExit('Unexpected Windows path: '+p)
print('/'+p)
PY
)
mkdir -p "$output_dir"; local_file="$output_dir/$(basename "$remote_sftp")"
scp -q "wy-desktop:$remote_sftp" "$local_file"
remote_hash=$(ssh -o BatchMode=yes -o ConnectTimeout=8 wy-desktop powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '$remote_file').Hash" | tr -d '\r\n' | tr '[:lower:]' '[:upper:]')
local_hash=$(shasum -a 256 "$local_file" | awk '{print toupper($1)}')
[[ "$local_hash" == "$remote_hash" ]] || { printf '%s\n' 'Transferred PNG hash mismatch.' >&2; exit 1; }
RESULT_JSON="$result" LOCAL_FILE="$local_file" LOCAL_SHA256="$local_hash" python3 - <<'PY'
import json, os
r=json.loads(os.environ['RESULT_JSON']); r['mac_output_file']=os.environ['LOCAL_FILE']; r['sha256']=os.environ['LOCAL_SHA256']
print(json.dumps(r,ensure_ascii=False,separators=(',',':')))
PY
