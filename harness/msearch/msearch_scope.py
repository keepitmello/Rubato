"""현재 폴더가 쓰는 기억 저장소를 정한다.

규칙은 하나이고 세 곳에 똑같이 있다: 엔진 기억 컴포넌트와 꿈 CLI 가 쓰는
`packages/memory-core/src/identity/project.ts`, 그리고 이 파일. 규칙이 갈라지면
검색이 엉뚱한 저장소를 가리키므로 셋을 함께 고친다.

  1. 폴더 설정의 `memory.agent`(비어 있지 않고 "auto" 가 아님)가 있으면 그 이름.
  2. git 작업 트리 안이면 저장소 루트(`git rev-parse --show-toplevel`)를 store.json
     `roots` 에 가진 저장소. 없으면 루트 이름을 slug 로, 그 이름을 다른 루트의 저장소가
     이미 쓰고 있으면 루트 경로의 짧은 해시를 붙인다.
  3. 홈 디렉터리 그 자체면 `home`.
  4. 그 밖에는 저장소가 없다.

사용자에 대한 기억은 프로젝트 저장소가 아니라 공용 사용자 저장소(`USER_STORE`) 하나에 있다.
어느 폴더도 그 이름으로 풀리지 않는다(위 규칙이 만드는 이름은 [a-z0-9-] 뿐이고 이 이름엔 점이 있다).
기본 검색은 현재 저장소와 사용자 저장소를 함께 본다 — `search_scopes` 가 그 규칙이다.

표준 라이브러리만 쓴다 — 검색 의존성 없이 시험할 수 있어야 한다.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import unicodedata
from pathlib import Path

STORE_FILE = "store.json"
#: 공용 사용자 저장소. 엔진 `packages/memory-core/src/identity/layout.ts` 의 USER_STORE_ID 와 같다.
USER_STORE = "user.shared"
HOME_STORE = "home"
FALLBACK_SLUG = "agent"
MAX_SLUG_LENGTH = 40


def sanitize_to_slug(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value)
    folded = re.sub("[\u0300-\u036f]", "", folded).lower()
    dashed = re.sub(r"[^a-z0-9]+", "-", folded)
    collapsed = re.sub(r"-{2,}", "-", dashed).strip("-")
    capped = collapsed[:MAX_SLUG_LENGTH].rstrip("-")
    return capped or FALLBACK_SLUG


def short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]


def explicit_store_name(value: str) -> str:
    """이름 붙인 저장소의 디렉터리 이름. slug 안전하면 그대로, 아니면 해시를 붙인다."""
    trimmed = value.strip()
    slug = sanitize_to_slug(trimmed)
    return slug if trimmed == slug else f"{slug}-{short_hash(trimmed)}"


def explicit_agent_name(cwd: Path) -> str | None:
    """cwd 에서 위로 올라가며 처음 만난 `.rubato/rubato.jsonc` 의 memory.agent.

    주석이 섞인 jsonc 라 정규식으로만 뽑는다. 못 찾거나 "auto" 면 None.
    """
    here = cwd.resolve()
    for directory in [here, *here.parents]:
        config = directory / ".rubato" / "rubato.jsonc"
        if not config.is_file():
            continue
        try:
            text = config.read_text(encoding="utf-8")
        except OSError:
            return None
        text = re.sub(r"//[^\n]*", "", text)
        match = re.search(r'"memory"\s*:\s*\{[^{}]*"agent"\s*:\s*"([^"]*)"', text)
        if match is None:
            return None
        value = match.group(1).strip()
        return None if value in ("", "auto") else value
    return None


def git_root(cwd: Path) -> Path | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = result.stdout.strip()
    if result.returncode != 0 or not out:
        return None
    return Path(os.path.realpath(out))


def read_store_record(store_dir: Path) -> dict | None:
    try:
        value = json.loads((store_dir / STORE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    roots = value.get("roots")
    return {
        "roots": [item for item in roots if isinstance(item, str)] if isinstance(roots, list) else [],
        "home": value.get("home") is True,
    }


def _store_for_root(agents_dir: Path, root: Path) -> str:
    root_text = str(root)
    try:
        stores = sorted(entry.name for entry in agents_dir.iterdir() if entry.is_dir())
    except OSError:
        stores = []
    for store in stores:
        record = read_store_record(agents_dir / store)
        if record is not None and root_text in record["roots"]:
            return store
    name = sanitize_to_slug(root.name)
    taken = read_store_record(agents_dir / name)
    if taken is not None and (taken["home"] or len(taken["roots"]) > 0):
        return f"{name}-{short_hash(root_text)}"
    return name


def resolve_store(cwd: Path, agents_dir: Path, home: Path | None = None) -> str | None:
    """cwd 가 쓰는 저장소 이름. 없으면 None. 아무것도 만들지 않는다."""
    explicit = explicit_agent_name(cwd)
    if explicit is not None:
        return explicit_store_name(explicit)
    root = git_root(cwd)
    if root is not None:
        return _store_for_root(agents_dir, root)
    home_dir = home if home is not None else Path(os.environ.get("HOME") or Path.home())
    if os.path.realpath(cwd) == os.path.realpath(home_dir):
        return HOME_STORE
    return None


NO_STORE = "no-store"
EMPTY_PROJECT = "empty-project"


def search_scopes(
    current: str | None,
    indexed: list[str],
    *,
    everything: bool = False,
    scope: str | None = None,
    user_only: bool = False,
) -> tuple[frozenset[str] | None, str | None]:
    """검색할 저장소 집합과, 결과에 붙일 알림. 집합이 None 이면 전체.

    - `-a`: 전체.
    - `--scope X`: X 하나.
    - `--user`: 사용자 저장소 하나.
    - 기본: 현재 저장소와 사용자 저장소. 사용자에 대한 사실은 프로젝트를 가리지 않고 필요하고,
      다른 프로젝트의 판단은 이 프로젝트의 답이 아니다. 그래서 묻지 않으면 넓히지 않는다.
      현재 저장소가 없으면 사용자 저장소만 보고 `NO_STORE`, 아직 기억이 없으면 `EMPTY_PROJECT` 를
      알린다 — 다른 프로젝트까지 보려면 `-a` 라고 말해 주려는 것이다.
    """
    if everything:
        return None, None
    if scope:
        return frozenset({scope}), None
    if user_only:
        return frozenset({USER_STORE}), None
    if current is None:
        return frozenset({USER_STORE}), NO_STORE
    return frozenset({current, USER_STORE}), None if current in indexed else EMPTY_PROJECT


def in_scopes(rel_path: str, scopes: frozenset[str] | None) -> bool:
    """색인의 rel_path(`<저장소>/repo/...`)가 집합 안의 저장소 것인가. None 이면 전부."""
    return scopes is None or rel_path.split("/", 1)[0] in scopes
