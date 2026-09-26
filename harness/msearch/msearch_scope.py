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
