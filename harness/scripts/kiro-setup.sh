#!/usr/bin/env bash
# Kiro 구독을 rubato 에 붙인다.
#
# kiro.rs(Anthropic Messages 호환 프록시)를 사이드카로 띄우고, 자격증명을 그
# 형식으로 옮긴다. kiro.rs 소스는 레포에 넣지 않는다 — 52k 줄 Rust 이고
# 업스트림이 활발해서, 도커 이미지로 받는 쪽이 유지보수가 싸다.
#
# 사용법:
#   kiro-setup.sh                      IDE 토큰으로 설정하고 사이드카를 띄운다
#   kiro-setup.sh export [파일]        자격증명을 파일로 뽑는다(남에게 줄 때)
#   kiro-setup.sh import <파일>        받은 파일로 설정하고 사이드카를 띄운다
#   kiro-setup.sh heal                 떠 있는 자격에 clientId 만 채운다(rubato 기동이 부름)
#   kiro-setup.sh ensure               자격을 고치고 사이드카까지 되살린다
#
# 자격증명은 레포 밖(기본 ~/.rubato-pi/kiro)에만 쓴다. 절대 커밋하지 마라.
set -euo pipefail

KIRO_IMAGE="${KIRO_IMAGE:-zyphrzero/kiro-rs:latest}"
KIRO_PORT="${KIRO_PORT:-8990}"
KIRO_DIR="${KIRO_DIR:-$HOME/.rubato-pi/kiro}"
KIRO_CONTAINER="${KIRO_CONTAINER:-kiro-rs}"
TOKEN_PATH="${KIRO_TOKEN_PATH:-$HOME/.aws/sso/cache/kiro-auth-token.json}"

# Builder ID 계정은 ListAvailableProfiles 가 403 이라 kiro.rs 가 ARN 을 스스로
# 구하지 못한다. Kiro IDE 가 실제로 200 을 받는 값과 같다.
BUILDER_ID_PROFILE_ARN="arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
SOCIAL_PROFILE_ARN="arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK"

die() { printf 'kiro-setup: %s\n' "$1" >&2; exit 1; }
info() { printf 'kiro-setup: %s\n' "$1"; }

# IDE 토큰(또는 이미 있는 credentials.json)을 kiro.rs 형식 한 건으로 바꾼다.
# 두 경로가 같은 규칙을 타야 "내 기기에서만 되는" 차이가 안 생긴다.
normalize_credential() {
  python3 - "$1" "$2" "$BUILDER_ID_PROFILE_ARN" "$SOCIAL_PROFILE_ARN" <<'PY'
import json, sys, os
src, out_path, builder_arn, social_arn = sys.argv[1:5]
raw = json.load(open(src))

# export 로 받은 파일은 이미 배열이다. IDE 토큰은 객체 하나다.
d = raw[0] if isinstance(raw, list) and raw else raw
if not isinstance(d, dict):
    sys.exit("자격증명 형식을 알 수 없다")
if not d.get("refreshToken"):
    sys.exit("refreshToken 이 없다 — 잘못된 파일이다")

method = (d.get("authMethod") or "").lower()
provider = d.get("provider") or ("BuilderId" if method == "idc" else "Github")
# 토큰에 진짜 ARN 이 있으면 그것이 최우선. 없으면 로그인 방식별 기본값.
arn = d.get("profileArn") or (social_arn if method == "social" else builder_arn)

cred = {
    "id": 1,
    "authMethod": "social" if method == "social" else "idc",
    "provider": provider,
    "profileArn": arn,
    # endpoint=ide 여야 origin 이 AI_EDITOR 로 나간다. cli 로 두면 상류가
    # "profileArn is required" 로 거부한다(같은 ARN 을 줘도).
    "endpoint": "ide",
    "region": d.get("region", "us-east-1"),
    "refreshToken": d["refreshToken"],
    "expiresAt": d.get("expiresAt", "1970-01-01T00:00:00Z"),
    "priority": 0,
}
# accessToken 은 만료돼도 무방하다(refreshToken 으로 갱신된다). 있으면 첫 호출이 빠르다.
if d.get("accessToken"):
    cred["accessToken"] = d["accessToken"]
for k in ("clientId", "clientSecret", "startUrl"):
    if d.get(k):
        cred[k] = d[k]

# IdC 갱신은 clientId 가 필요하다. IDE 토큰은 clientIdHash 만 남기고,
# 값은 ~/.aws/sso/cache/<hash>.json 에 있다. 없으면 토큰이 만료된 뒤
# kiro.rs 가 "IdC 刷新需要 clientId" 로 3번 죽고 자격을 끄는다.
if not cred.get("clientId"):
    hid = d.get("clientIdHash")
    token_path = os.path.join(os.path.expanduser("~"), ".aws", "sso", "cache", "kiro-auth-token.json")
    if not hid and os.path.isfile(token_path):
        try:
            token = json.load(open(token_path))
        except (OSError, json.JSONDecodeError):
            token = None
        if isinstance(token, dict):
            hid = token.get("clientIdHash")
            for k in ("clientId", "clientSecret"):
                if token.get(k):
                    cred[k] = token[k]
    if hid and not cred.get("clientId"):
        candidates = [
            os.path.join(os.path.expanduser("~"), ".aws", "sso", "cache", f"{hid}.json"),
            os.path.join(os.path.dirname(os.path.abspath(src)), f"{hid}.json"),
        ]
        for cache_path in candidates:
            if not os.path.isfile(cache_path):
                continue
            try:
                extra = json.load(open(cache_path))
            except (OSError, json.JSONDecodeError):
                continue
            if extra.get("clientId"):
                cred["clientId"] = extra["clientId"]
            if extra.get("clientSecret"):
                cred["clientSecret"] = extra["clientSecret"]
            break

if cred["authMethod"] == "idc" and not cred.get("clientId"):
    print("kiro-setup: 경고 — IdC 인데 clientId 가 없다. 해시 파일(~/.aws/sso/cache/<clientIdHash>.json)을 확인해라.", file=sys.stderr)

with open(out_path, "w") as fh:
    json.dump([cred], fh, indent=2)
os.chmod(out_path, 0o600)
print(f"  authMethod={cred['authMethod']} provider={cred['provider']} endpoint=ide")
PY
}

# 사이드카를 띄우고 두 모델이 실제로 보이는지 확인한다.
start_and_verify() {
  local config="$KIRO_DIR/config.json"
  if [ ! -f "$config" ]; then
    local api_key
    api_key="sk-kiro-local-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    python3 - "$config" "$api_key" "$KIRO_PORT" <<'PY'
import json, sys, os
path, api_key, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
json.dump({
    "host": "0.0.0.0",       # 컨테이너 내부. 아래 -p 로 loopback 에만 노출한다.
    "port": port,
    "apiKey": api_key,
    "region": "us-east-1",
    "tlsBackend": "rustls",
    "defaultEndpoint": "ide",
    "loadBalancingMode": "priority",
}, open(path, "w"), indent=2)
os.chmod(path, 0o600)
PY
    info "config.json 생성"
  else
    info "config.json 유지(기존 API 키 보존)"
  fi

  local api_key
  api_key="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["apiKey"])' "$config")"
  python3 - "$KIRO_DIR/credentials.json" <<'PY' || die "IdC 자격에 clientId 가 없다. 사이드카를 띄우지 않는다."
import json, sys
raw = json.load(open(sys.argv[1]))
cred = raw[0] if isinstance(raw, list) else raw
if (cred.get("authMethod") or "").lower() == "idc" and not cred.get("clientId"):
    sys.exit(1)
PY

  info "이미지 확인: $KIRO_IMAGE"
  docker pull "$KIRO_IMAGE" >/dev/null

  docker rm -f "$KIRO_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$KIRO_CONTAINER" --restart unless-stopped \
    -p "127.0.0.1:${KIRO_PORT}:${KIRO_PORT}" \
    -v "$KIRO_DIR:/app/config" \
    "$KIRO_IMAGE" >/dev/null
  info "컨테이너 기동: $KIRO_CONTAINER (127.0.0.1:$KIRO_PORT)"

  # 토큰 갱신과 모델 캐시 예열에 몇 초 걸린다.
  local i
  for i in $(seq 1 30); do
    if curl -sf -m 3 "http://127.0.0.1:${KIRO_PORT}/v1/models" -H "x-api-key: $api_key" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  local models
  models="$(curl -sf -m 5 "http://127.0.0.1:${KIRO_PORT}/v1/models" -H "x-api-key: $api_key" 2>/dev/null || true)"
  [ -n "$models" ] || die "kiro.rs 가 응답하지 않는다. docker logs $KIRO_CONTAINER 를 봐라."

  printf '%s' "$models" | python3 -c '
import json, sys
ids = [m.get("id") or m.get("model_id") for m in json.load(sys.stdin).get("data", [])]
print(f"kiro-setup: 모델 {len(ids)}개")
missing = [w for w in ("claude-opus-5", "gpt-5.6-sol") if w not in ids]
if missing:
    print("kiro-setup: 없음 -> " + ", ".join(missing))
    print("kiro-setup: 무료 등급이면 이 둘은 안 나온다. 유료 구독 계정이어야 한다.")
    sys.exit(1)
print("kiro-setup: claude-opus-5, gpt-5.6-sol 확인")
'

  cat <<EOF

붙었다. rubato 를 다시 띄운다:  rubato restart

모델 id 는 kiro/claude-opus-5 와 kiro/gpt-5.6-sol 이다.
브리지가 ${KIRO_DIR}/config.json 에서 키를 직접 읽으므로 환경변수는 필요 없다.
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker 가 없다. OrbStack 이나 Docker Desktop 을 설치해라."
  docker_ready || die "docker 데몬이 꺼져 있다. OrbStack/Docker Desktop 을 켜라."
}

# Docker Desktop 이 앱만 남고 VM 은 꺼진 상태면 `docker info` 자체가 오래
# 매달린다. Kiro 첫 요청이 무한히 묶이지 않도록 모든 readiness probe 를 제한한다.
docker_ready() {
  python3 - <<'PY'
import subprocess, sys
try:
    result = subprocess.run(
        ["docker", "info"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=3,
    )
except (OSError, subprocess.TimeoutExpired):
    sys.exit(1)
sys.exit(result.returncode)
PY
}

kiro_ready() {
  [ -f "$KIRO_DIR/config.json" ] || return 1
  local api_key
  api_key="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["apiKey"])' "$KIRO_DIR/config.json" 2>/dev/null)" || return 1
  curl -sf -m 3 "http://127.0.0.1:${KIRO_PORT}/v1/models" -H "x-api-key: $api_key" >/dev/null 2>&1
}

# 컨테이너의 restart policy 는 Docker 데몬이 먼저 떠야만 효력이 있다. macOS
# 데스크톱 런타임은 로그인 뒤에도 앱이 안 뜰 수 있으므로, 자격이 있는 기기에서
# Rubato 가 시작될 때 현재 Docker context 의 런타임을 한 번 깨운다. Linux 의
# 시스템 Docker 는 OS supervisor 소유라 여기서 sudo 로 건드리지 않는다.
ensure_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker_ready && return 0

  if [ "$(uname -s)" = "Darwin" ] && command -v open >/dev/null 2>&1; then
    local context endpoint app=""
    context="$(docker context show 2>/dev/null || true)"
    endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
    case "$context" in
      orbstack) app="OrbStack" ;;
      desktop-linux) app="Docker" ;;
      *)
        case "$endpoint" in
          *orbstack*) app="OrbStack" ;;
          *docker*) app="Docker" ;;
        esac
        # endpoint 도 모호하면 설치된 런타임이 하나뿐일 때만 고른다. 둘 다
        # 있는 기기에서 임의로 하나를 띄우면 현재 context 와 어긋난다.
        if [ -z "$app" ]; then
          if [ -d /Applications/OrbStack.app ] && [ ! -d /Applications/Docker.app ]; then app="OrbStack"; fi
          if [ -d /Applications/Docker.app ] && [ ! -d /Applications/OrbStack.app ]; then app="Docker"; fi
        fi
        ;;
    esac
    if [ "$app" = "Docker" ] && docker desktop status >/dev/null 2>&1; then
      docker desktop restart --detach --timeout 30 >/dev/null 2>&1 \
        || open -gja Docker >/dev/null 2>&1 || true
    elif [ "$app" = "Docker" ]; then
      docker desktop start --detach --timeout 30 >/dev/null 2>&1 \
        || open -gja Docker >/dev/null 2>&1 || true
    else
      [ -n "$app" ] && open -gja "$app" >/dev/null 2>&1 || true
    fi
  elif [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    # Docker Desktop for Linux 는 user unit 이다. 시스템 docker.service 는
    # root supervisor 소유이므로 비밀번호 없는 우회 기동을 시도하지 않는다.
    systemctl --user start docker-desktop >/dev/null 2>&1 || true
  fi

  local i
  for i in $(seq 1 30); do
    docker_ready && return 0
    sleep 1
  done
  return 1
}

ensure_sidecar() {
  [ -f "$KIRO_DIR/config.json" ] && [ -f "$KIRO_DIR/credentials.json" ] \
    || die "Kiro 설정이 없다. 먼저 kiro-setup.sh setup 또는 import <파일>을 실행해라."
  kiro_ready && return 0
  ensure_docker || return 1

  if docker container inspect "$KIRO_CONTAINER" >/dev/null 2>&1; then
    # 데몬이 막 뜬 직후에는 restart policy 가 컨테이너를 이미 올리는 중일 수
    # 있다. 실행 중이면 기다리기만 한다 — 동시에 연 Rubato 세션이 서로의
    # Kiro 호출을 restart 로 끊어서는 안 된다. 멈춘 컨테이너만 시작한다.
    if ! docker inspect -f '{{.State.Running}}' "$KIRO_CONTAINER" 2>/dev/null | grep -qx true; then
      docker start "$KIRO_CONTAINER" >/dev/null 2>&1 || return 1
    fi
    local i
    for i in $(seq 1 30); do
      kiro_ready && return 0
      sleep 1
    done
    return 1
  fi

  # Docker 상태를 초기화했거나 다른 기기로 설정만 옮긴 경우다. 같은 설정과
  # 자격 파일에서 컨테이너를 다시 만들고 start_and_verify 가 실응답을 확인한다.
  start_and_verify >/dev/null
}

# 이미 쓴 credentials.json 을 제자리에서 고친다. refreshToken/
# accessToken 은 건드리지 않는다 — kiro.rs 가 방금 새로 갱신한 값을
# setup 이 IDE 토큰으로 덮어쓰면 다음 호출이 지난 토큰으로 돌아간다.
# 사이드카를 안 쓰는 기기는 자격 파일이 없어서 여기서 바로 나간다.
heal_credentials() {
  local cred="$KIRO_DIR/credentials.json"
  [ -f "$cred" ] || return 0

  local out
  out=$(python3 - "$cred" "$TOKEN_PATH" <<'PY'
import json, os, sys

cred_path, token_path = sys.argv[1:3]
raw = json.load(open(cred_path))
if not isinstance(raw, list) or not raw or not isinstance(raw[0], dict):
    sys.exit(0)
cred = raw[0]
changed = False

def load_json(path):
    try:
        return json.load(open(path))
    except (OSError, json.JSONDecodeError):
        return None

def merge_client(extra):
    global changed
    if not isinstance(extra, dict):
        return
    for key in ("clientId", "clientSecret"):
        if extra.get(key) and cred.get(key) != extra[key]:
            cred[key] = extra[key]
            changed = True

if not cred.get("clientId"):
    hid = cred.get("clientIdHash")
    token = load_json(token_path) if os.path.isfile(token_path) else None
    if isinstance(token, dict):
        hid = hid or token.get("clientIdHash")
        merge_client(token)
    if hid and not cred.get("clientId"):
        for cache_path in (
            os.path.join(os.path.expanduser("~"), ".aws", "sso", "cache", f"{hid}.json"),
            os.path.join(os.path.dirname(os.path.abspath(token_path or cred_path)), f"{hid}.json"),
        ):
            extra = load_json(cache_path)
            if extra and extra.get("clientId"):
                merge_client(extra)
                break

if cred.get("clientId") and (cred.get("disabled") or cred.get("disabledReason")):
    cred["disabled"] = False
    cred.pop("disabledReason", None)
    changed = True

if not changed:
    sys.exit(0)
json.dump(raw, open(cred_path, "w"), indent=2)
os.chmod(cred_path, 0o600)
print("healed")
PY
) || return 0
  [ "$out" = "healed" ] || return 0

  # 파일을 고치면 떠 있는 kiro.rs 는 예전 메모리를 그대로 쓴다.
  if docker_ready && docker inspect -f '{{.State.Running}}' "$KIRO_CONTAINER" 2>/dev/null | grep -qx true; then
    docker restart "$KIRO_CONTAINER" >/dev/null 2>&1 || true
  fi
  return 0
}

case "${1:-setup}" in
  export)
    # 자격증명을 남에게 주기 위해 뽑는다. 받는 쪽은 로그인이 필요 없다.
    OUT="${2:-$HOME/kiro-credentials.json}"
    SRC="$KIRO_DIR/credentials.json"
    [ -f "$SRC" ] || SRC="$TOKEN_PATH"
    [ -f "$SRC" ] || die "내보낼 자격증명이 없다. 먼저 kiro-setup.sh 를 돌려라."

    normalize_credential "$SRC" "$OUT" >/dev/null
    chmod 600 "$OUT"
    python3 - "$OUT" <<'PY' || die "내보낸 파일에 clientId 가 없다. 이 파일을 넘기면 받는 쪽이 한 시간 뒤 죽는다."
import json, sys
c = json.load(open(sys.argv[1]))[0]
if (c.get("authMethod") or "").lower() == "idc" and not c.get("clientId"):
    sys.exit(1)
print(f"kiro-setup: 내보냄 -> {sys.argv[1]}")
print(f"  authMethod={c['authMethod']} provider={c['provider']}")
PY
    cat <<EOF

이 파일 하나면 받는 쪽은 로그인 없이 붙는다:

  kiro-setup.sh import kiro-credentials.json

경고 — 이 파일은 계정 접근권 그 자체다(refreshToken).
  · 받은 사람은 네 Kiro 계정을 그대로 쓸 수 있다. 회수하려면 비밀번호를 바꿔야 한다.
  · 크레딧은 공유된다. 한쪽이 쓰면 다른 쪽 몫이 준다 — 이게 실질 제약이다.
  · 메신저나 메일로 보내면 그 서버에도 남는다. 전달 뒤 원본을 지워라:
      rm $OUT

같은 집·같은 망에서 기기만 다른 경우라면 계정 차단을 걱정할 일은 거의 없다.
machineId 는 이 파일에 실리지 않아 받는 기기가 자기 것을 따로 만든다.
EOF
    ;;

  import)
    # 받은 자격증명으로 붙는다. IDE 도 kiro-cli 도 필요 없다.
    IN="${2:-}"
    [ -n "$IN" ] || die "받은 파일 경로를 줘라: kiro-setup.sh import kiro-credentials.json"
    [ -f "$IN" ] || die "파일이 없다: $IN"
    require_docker

    mkdir -p "$KIRO_DIR"
    chmod 700 "$KIRO_DIR"
    normalize_credential "$IN" "$KIRO_DIR/credentials.json"
    info "자격증명 등록: $KIRO_DIR/credentials.json"
    start_and_verify
    ;;

  heal)
    # rubato 기동이 부른다. 자격 파일이 없으면 그냥 나간다.
    heal_credentials
    ;;

  ensure)
    # 실제 kiro/* 요청이 부른다. 설정하지 않은 기기에서는 성공한 척한 뒤
    # 죽은 loopback 으로 넘기지 않고 최초 설정 방법을 즉시 알려준다.
    [ -f "$KIRO_DIR/credentials.json" ] \
      || die "Kiro 자격이 없다. 먼저 kiro-setup.sh setup 또는 import <파일>을 실행해라."
    heal_credentials
    ensure_sidecar || die "kiro.rs 를 복원하지 못했다. Docker 런타임과 docker logs $KIRO_CONTAINER 를 확인해라."
    ;;

  setup|"")
    # 이 기기의 Kiro IDE 토큰으로 설정한다.
    require_docker
    [ -f "$TOKEN_PATH" ] || die "토큰이 없다: $TOKEN_PATH
  Kiro IDE 로 로그인해라. (kiro-cli login 은 OAuth 콜백이 자주 타임아웃한다.)
  자격증명 파일을 받았다면:  kiro-setup.sh import <파일>"

    mkdir -p "$KIRO_DIR"
    chmod 700 "$KIRO_DIR"
    normalize_credential "$TOKEN_PATH" "$KIRO_DIR/credentials.json"
    start_and_verify
    ;;

  *)
    die "모르는 명령: $1 (setup | export | import | heal | ensure)"
    ;;
esac
