# msearch

에이전트 메모리를 의미 기반으로 검색한다. BM25 + 벡터 하이브리드에 한국어 형태소
토크나이즈와 최신성·앵커 가중치가 얹혀 있다.

원본은 `~/.claude/roo-channel/scripts` 에서 한 채널 전용으로 자란 코드다. 여기서는
경로와 이름공간을 설정으로 빼서 아무 메모리 저장소나 가리킬 수 있게 했다. 랭킹 로직은
건드리지 않았다 — 재활용의 알맹이가 거기 있다.

## 쓰기

```
msearch '찾을 내용'            현재 프로젝트 기억에서 검색
msearch -a '내용'              모든 기억에서 검색
msearch --scope <id> '내용'    한 저장소로 좁혀서
msearch --list-scopes          색인된 저장소 목록 (* = 현재 위치)
msearch --index                색인 수동 갱신
msearch --reindex              전체 재색인
msearch --doctor               설치 상태 진단
```

`--doctor` 부터 돌리면 된다. 뭐가 없는지와 다음에 뭘 할지 알려준다.

## 스코프

기본은 **현재 디렉터리에 해당하는 메모리 저장소**다. 색인은 메모리 루트를 통째로 훑으므로
여러 프로젝트의 기억이 한 인덱스에 같이 있고, 그중 현재 곳의 것만 보여준다. `-a` 로 전체를 본다.

현재 디렉터리가 색인에 없으면(아직 안 쌓였거나 메모리 밖에서 실행 중) 조용히 0건을 주는 대신
전체 검색으로 떨어진다.

## 색인은 알아서 따라온다

검색할 때마다 색인이 실제 파일과 어긋나는지 보고, 뒤처졌으면 바뀐 파일만 다시 색인한다.
메모리에 뭘 쓴 뒤의 검색은 반드시 최신을 본다 — 도구로 썼든 손으로 고쳤든 `git pull` 을 받았든
상관없다.

변경이 없으면 검사는 20ms 안팎이다(로컬 해시 대조만 한다). 끄려면 `MSEARCH_NO_AUTOINDEX=1`.

별도의 git 훅은 안 건다 — memory-core 가 메모리 저장소의 `post-commit` 을 자기 것으로 쓰고
매 startup 마다 재생성한다. 그 파일을 놓고 다투는 대신 상태를 본다.

## 필요한 것

| 항목 | 누가 챙기나 |
|------|------|
| Python 3.13.2 + 패키지 잠금 | `install.sh --apply` 가 `harness/msearch/.venv` 에 재현한다 |
| JDK 17 | **손으로 깐다** (`brew install openjdk@17`) |
| Redis 8.4.0 + Search 8.4.2 | **손으로 깐다** (아래) |
| `OPENAI_API_KEY` | **손으로 넣는다** (아래) |

네 개가 다 서야 검색이 돈다. 어디까지 됐는지는 `msearch --doctor` 한 곳에서만 판정한다.

### python

정상 기준은 [`runtime.lock`](runtime.lock)에 두고, 설치기는 그 Python 버전과
[`requirements.lock`](requirements.lock)의 전체 패키지 버전이 일치하는 환경만 쓴다.
`install.sh --apply`는 머신의 전역 패키지를 재사용하지 않고 `harness/msearch/.venv`를
잠금대로 임시 경로에서 완성한 뒤 바꾼다. 설치가 끊겨 불완전한 venv가 남아도 런처는 선택하지 않는다.
다른 파이썬을 명시하려면 `MSEARCH_PYTHON`을 쓰되 `msearch --doctor`에서 잠금 일치를 확인한다.
정확한 Python patch 버전은 `uv`가 받아서 venv를 만들므로 머신의 기본 Python 버전에 기대지 않는다.

시스템 파이썬에 `pip install` 이 `externally-managed-environment` 로 거부당하는 것은
PEP 668 이다. `--break-system-packages` 로 뚫는 대신 venv 를 쓰는 이유가 그것이다.

### Redis

정상 기준은 `runtime.lock`의 **Redis 8.4.0 + Search 8.4.2**다. 이 조합에서 색인, BM25, vector,
`FT.HYBRID`를 검증했다. `redis-server --version`만 보지 말고 `INFO modules`의
`search_version`까지 확인해야 한다.

macOS에서는 Redis 공식 tap의 8.4.0 cask를 고정 커밋에서 설치한다:

```bash
brew tap redis/redis
tap="$(brew --repo redis/redis)"
git -C "$tap" checkout eb1de700eae6b3a2c398f2c287ed9650c6710cea
brew trust --cask redis/redis/redis
HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask redis/redis/redis
git -C "$tap" switch -
```

그 cask는 arm64와 x86_64용 8.4.0 바이너리 및 Search 모듈을 함께 담는다. 설치 뒤에는
tap을 원래 브랜치로 돌려도 설치된 8.4.0은 유지된다. 자동 업그레이드는 검증 전까지 하지 않는다.

6380으로 띄우고 확인한다:

```bash
redis-server --port 6380 \
  --dir /opt/homebrew/var/db/redis \
  --save '300 10' \
  --loadmodule /opt/homebrew/opt/redis/lib/redis/modules/redisearch.so \
  --loadmodule /opt/homebrew/opt/redis/lib/redis/modules/rejson.so
redis-cli -p 6380 INFO server | grep redis_version       # 8.4.0
redis-cli -p 6380 INFO modules | grep search_version     # 8.4.2
redis-cli -p 6380 COMMAND INFO FT.CREATE FT.HYBRID       # 둘 다 있어야 함
```

**`/opt/homebrew/etc/redis.conf` 를 쓰지 않는다.** 한 머신에서 그 파일이 바이너리(8.4.0)보다
새 버전용 설정(`array-slice-size`, `hash-*-template` 등)을 담고 있어 서버가 기동을
거부했다("Module Configuration detected without loadmodule directive"). conf 는 cask와
따로 움직여서 또 어긋나간다 — 필요한 인자만 명령줄로 준다. 모듈 경로는 cask 가
`/opt/homebrew/opt/redis` 심링크를 안 만들면 직접 걸어준다:
`ln -sfn /opt/homebrew/Caskroom/redis/8.4.0 /opt/homebrew/opt/redis`

**계속 켜두기.** cask는 `brew services`가 관리하지 않으므로 로그인 때 뜨게 하려면
직접 건다. macOS 예시 (`~/Library/LaunchAgents/dev.msearch.redis.plist`):

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/redis-server</string>
  <string>--port</string><string>6380</string>
  <string>--daemonize</string><string>no</string>
  <string>--dir</string><string>/opt/homebrew/var/db/redis</string>
  <string>--save</string><string>300 10</string>
  <string>--loadmodule</string><string>/opt/homebrew/opt/redis/lib/redis/modules/redisearch.so</string>
  <string>--loadmodule</string><string>/opt/homebrew/opt/redis/lib/redis/modules/rejson.so</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
```

`launchctl bootstrap gui/$(id -u) <plist>` 로 걸고 `launchctl bootout gui/$(id -u)/dev.msearch.redis` 로 끈다.

### OPENAI_API_KEY

환경변수로 두거나 `<state>/.env` 에 `OPENAI_API_KEY=sk-...` 한 줄로 둔다.
state 경로는 `--doctor` 가 알려준다.

ChatGPT 구독의 OAuth 토큰(`~/.codex/auth.json`)으로는 안 된다 — 그 파일의
`OPENAI_API_KEY` 는 `auth_mode` 가 `chatgpt` 이면 `null` 이다. platform.openai.com 의
API 키가 따로 필요하다. 비용은 `text-embedding-3-small` 기준 100만 토큰에 $0.02 라
기억 수십 개 규모에서는 사실상 0 이다.

## 설정

전부 선택이고, 기본값은 rubato 메모리 레이아웃을 가리킨다.

| 변수 | 기본값 | 뜻 |
|------|--------|-----|
| `MSEARCH_ROOT` | `~/.rubato/memory/agents` | 색인 대상 루트 |
| `MSEARCH_STATE_DIR` | `<root>/../msearch-state` | 회상 로그·`.env` 등 런타임 상태 |
| `MSEARCH_REDIS_URL` | `redis://localhost:6380` | |
| `MSEARCH_INDEX` | `msearch_idx` | RediSearch 인덱스 이름 |
| `MSEARCH_CHANNEL` | `rubato` | 논리적 이름공간. 한 redis 에 여러 코퍼스를 나눠 담을 때 |
| `MSEARCH_EMBEDDING_MODEL` | `text-embedding-3-small` | |

`ROO_MEMORY_*` 도 계속 읽는다. roo-channel 에서 넘어온 기존 설정이 그대로 살아야 하기
때문이고, 새 이름이 있으면 새 이름이 이긴다.

다른 코퍼스를 가리키려면 루트와 채널을 같이 바꾼다. 채널을 안 바꾸면 한 이름공간에
두 코퍼스가 섞인다.

```bash
MSEARCH_ROOT=~/notes MSEARCH_CHANNEL=notes msearch --index
```

## 구조

| 파일 | 역할 |
|------|------|
| `msearch` | 진입점. 백엔드가 죽어 있으면 검색 대신 진단으로 보낸다 |
| `msearch_config.py` | 모든 경로·이름 해석. 다른 파일은 여기서만 읽는다 |
| `msearch_env.py` | Python·패키지가 두 잠금 파일과 일치하는지 판정한다 |
| `runtime.lock` | 검증한 Python·Java·Redis·Search 버전의 정본 |
| `requirements.lock` | 검증한 Python 패키지 전체 버전의 정본 |
| `test-runtime.sh` | 설치 모드와 런처 환경 선택의 회귀 테스트 |
| `msearch_freshness.py` | 색인이 뒤처졌는지 보고 따라잡는다 |
| `msearch_doctor.py` | 설치 진단 |
| `memory-index.py` | 마크다운 → 청크 → 임베딩 → Redis |
| `memory-search.py` | 하이브리드 검색과 랭킹 |
| `memory_affect.py` / `memory_entities.py` | 정서 신호, 인물 별칭 |
| `memory_episode_adapter.py` / `memory_episode_review.py` | 에피소드 v2 게이트 (선택 레이어, 없으면 통과) |

## 알아둘 것

- **검색 결과는 사용자 화면에만 뜬다.** 에이전트 컨텍스트로 자동 주입되지 않는다.
- 색인은 `.git/` 과 `runtime/` 을 제외한다 — 기억이 아니라 기계 상태다.
- 에피소드 v2 인덱스(sqlite)가 없으면 게이트는 전 건 통과시킨다. 순수 마크다운
  코퍼스에서는 그게 정상 동작이다.
