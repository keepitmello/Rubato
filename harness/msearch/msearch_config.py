"""msearch 설정 한 군데.

원본은 roo-channel 안에 살면서 `PROJECT_ROOT = parents[1]` 로 자기 레포를 가리켰다.
스크립트가 곧 그 채널이었으니 그래도 됐다. 여기서는 스크립트와 데이터가 갈라진다 —
코드는 이 레포에, 색인 대상은 사용자의 메모리 저장소에 있다. 그래서 경로는 상수가
아니라 환경변수로 주입받고, 기본값은 rubato 의 메모리 레이아웃을 가리킨다.

환경변수 (전부 선택):
  MSEARCH_ROOT         색인 대상 루트. 기본 ~/.rubato/memory/agents
  MSEARCH_INCLUDE      검색할 상대 파일·폴더 경로의 JSON 배열. 기본 루트 전체
  MSEARCH_EXCLUDE      추가로 제외할 상대경로 조각의 JSON 배열
  MSEARCH_STATE_DIR    회상 로그 등 런타임 상태. 기본 <root>/../msearch-state
  MSEARCH_REDIS_URL    기본 redis://localhost:6380
  MSEARCH_INDEX        기본 msearch_idx
  MSEARCH_CHANNEL      논리적 이름공간. 기본 rubato
  MSEARCH_EMBEDDING_MODEL  기본 text-embedding-3-small
  OPENAI_API_KEY       임베딩용. 없으면 색인이 못 돈다.

`ROO_MEMORY_*` 도 계속 읽는다. roo-channel 에서 넘어온 사람의 기존 설정이 그대로
살아야 하기 때문이다. 새 이름이 있으면 새 이름이 이긴다.
"""

from __future__ import annotations

import os
import re
import json
from pathlib import Path
from typing import Iterable


def _env(new_name: str, legacy_name: str, default: str) -> str:
    value = os.getenv(new_name)
    if value is not None and value.strip() != "":
        return value
    legacy = os.getenv(legacy_name)
    if legacy is not None and legacy.strip() != "":
        return legacy
    return default


def _default_root() -> str:
    return str(Path.home() / ".rubato" / "memory" / "agents")


#: 색인 대상 루트. 이 아래 *.md 를 훑는다.
MEMORY_ROOT = Path(_env("MSEARCH_ROOT", "ROO_MEMORY_ROOT", _default_root())).expanduser()

# A private repository can keep its original layout without indexing every document in it.
# Missing means the whole root; an explicit list is an allowlist, not another copy of the records.
def _paths(name: str) -> list[str] | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    value = json.loads(raw)
    if not isinstance(value, list) or any(not isinstance(item, str) or not item
            or Path(item).is_absolute() or ".." in Path(item).parts for item in value):
        raise ValueError(f"{name} must be a JSON list of relative paths")
    return value


CORPUS_PATHS = _paths("MSEARCH_INCLUDE")
EXCLUDE_PATH_FRAGMENTS = (
    "_tech-notes/", "/backups/", "/backup/", "/.git/", "/runtime/",
    *(_paths("MSEARCH_EXCLUDE") or []),
)


def walk_markdown(directory: Path) -> Iterable[Path]:
    """Follow linked folders once by real path, including when a link loops back."""
    seen: set[str] = set()
    for root, dirs, names in os.walk(directory, followlinks=True):
        real = os.path.realpath(root)
        if real in seen:
            dirs[:] = []
            continue
        seen.add(real)
        dirs.sort()
        for name in sorted(names):
            if name.endswith(".md"):
                yield Path(root, name)


def corpus_files(root: Path) -> list[Path]:
    """The same selected corpus for indexing and freshness, with no network or content reads."""
    found: dict[str, Path] = {}
    for relative in CORPUS_PATHS if CORPUS_PATHS is not None else ["."]:
        source = root / relative
        paths = [source] if source.is_file() else walk_markdown(source)
        for file in paths:
            if not file.is_file() or file.suffix != ".md":
                continue
            try:
                rel = file.resolve().relative_to(root.resolve()).as_posix()
            except ValueError:
                rel = file.resolve().as_posix()
            if any(fragment in f"/{rel}/" for fragment in EXCLUDE_PATH_FRAGMENTS):
                continue
            found[str(file.resolve())] = file
    return sorted(found.values(), key=lambda file: str(file))

#: 런타임 상태(회상 로그 등). 색인 대상 안에 두면 자기 기록을 자기가 색인하게 된다.
_state_default = str(MEMORY_ROOT.parent / "msearch-state")
STATE_DIR = Path(_env("MSEARCH_STATE_DIR", "ROO_STATE_DIR", _state_default)).expanduser()

REDIS_URL = _env("MSEARCH_REDIS_URL", "REDIS_URL", "redis://localhost:6380")
INDEX_NAME = _env("MSEARCH_INDEX", "ROO_MEMORY_INDEX", "msearch_idx")
EMBEDDING_MODEL = _env("MSEARCH_EMBEDDING_MODEL", "ROO_MEMORY_EMBEDDING_MODEL", "text-embedding-3-small")

CHANNEL_ID = _env("MSEARCH_CHANNEL", "ROO_MEMORY_CHANNEL", "rubato")
CHANNEL_KEY_ID = re.sub(r"[^A-Za-z0-9_.-]+", "-", CHANNEL_ID).strip("-") or "default"

KEY_PREFIX = _env("MSEARCH_KEY_PREFIX", "ROO_MEMORY_KEY_PREFIX", f"msearch:memory:channel:{CHANNEL_KEY_ID}:")
HASH_PREFIX = _env("MSEARCH_HASH_PREFIX", "ROO_MEMORY_HASH_PREFIX", f"msearch:file_hash:channel:{CHANNEL_KEY_ID}:")
MANIFEST_KEY = _env(
    "MSEARCH_MANIFEST_KEY", "ROO_MEMORY_MANIFEST_KEY", f"msearch:memory:channel:{CHANNEL_KEY_ID}:manifest"
)

# 합의 기록(intent)은 기억과 다른 코퍼스라 인덱스·키를 따로 둔다. 기억 인덱스의 PREFIX 는
# 만들 때 고정돼 바꿀 수 없고, 한 인덱스에 섞으면 기억 랭킹과 정리 로직이 intent 를 건드린다.
INTENT_INDEX_NAME = os.getenv("MSEARCH_INTENT_INDEX") or f"{INDEX_NAME}_intent"
INTENT_KEY_PREFIX = f"msearch:intent:channel:{CHANNEL_KEY_ID}:"
INTENT_HASH_PREFIX = f"msearch:intent_hash:channel:{CHANNEL_KEY_ID}:"
INTENT_MANIFEST_KEY = f"msearch:intent_manifest:channel:{CHANNEL_KEY_ID}"

TOP_K = int(_env("MSEARCH_TOP_K", "ROO_MEMORY_TOP_K", "30"))
RETURN_K = int(_env("MSEARCH_RETURN_K", "ROO_MEMORY_RETURN_K", "3"))
MAX_VECTOR_DISTANCE = float(_env("MSEARCH_MAX_VECTOR_DISTANCE", "ROO_MEMORY_MAX_VECTOR_DISTANCE", "0.62"))


def state_path(name: str) -> Path:
    return STATE_DIR / name


def describe() -> str:
    """`--doctor` 가 보여주는 현재 해석값."""
    return "\n".join(
        [
            f"  root      {MEMORY_ROOT}",
            f"  state     {STATE_DIR}",
            f"  redis     {REDIS_URL}",
            f"  index     {INDEX_NAME}",
            f"  intent    {INTENT_INDEX_NAME}",
            f"  channel   {CHANNEL_ID}",
            f"  embedding {EMBEDDING_MODEL}",
        ]
    )
