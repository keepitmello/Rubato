"""색인이 메모리보다 뒤처졌는지 보고, 뒤처졌으면 따라잡는다.

처음에는 git post-commit 훅으로 붙이려 했다. 메모리 쓰기가 전부 커밋을 거치니 자리는
맞았지만, memory-core 가 그 훅 파일을 자기 것으로 쓰고 매 startup 마다 재생성한다
("Do not edit by hand - regenerated on startup"). 덧붙여도 다음 실행에 지워지고,
core.hooksPath 로 비키면 미러 푸시가 죽는다. 남의 자동 생성물과 한 파일을 두고 다투는
구조라 이길 수가 없다.

그래서 신호를 바꿨다. "커밋이 일어났다"를 감지하는 대신 "색인이 실제와 다르다"를 본다.
색인은 이미 파일별 지문을 들고 있으므로, 검색 직전에 로컬 파일 지문과 대조하면 된다.
임베딩 호출도 네트워크도 없는 로컬 해시 비교라 파일 수십 개면 수십 밀리초다.

이쪽이 훅보다 강하다. 어떤 경로로 메모리가 바뀌든 — 도구든 손편집이든 git pull 이든 —
다음 검색이 반드시 최신을 본다.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

import msearch_config as config

FINGERPRINT_VERSION = "channel-v4"


def _fingerprint(path: Path) -> str:
    return f"{FINGERPRINT_VERSION}:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _file_id(path: Path, root: Path) -> str:
    resolved = path.resolve()
    try:
        rel = str(resolved.relative_to(root))
    except ValueError:
        try:
            rel = str(resolved.relative_to(Path.home()))
        except ValueError:
            rel = str(resolved)
    # memory-index.py 의 file_id 와 반드시 같아야 한다. 다르면 항상 stale 로 읽혀
    # 검색마다 전체 재색인이 돈다.
    return hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]


def _corpus(root: Path) -> list[Path]:
    if not root.exists():
        return []
    skip = ("/.git/", "/runtime/", "/backups/", "/backup/", "/_tech-notes/", "/diary/raw/")
    found: list[Path] = []
    for path in root.rglob("*.md"):
        marker = "/" + str(path) + "/"
        if any(fragment in marker for fragment in skip):
            continue
        if path.is_file():
            found.append(path)
    return found


def is_stale(client) -> bool:
    """색인과 실제 파일이 어긋났으면 True.

    Redis 가 죽어 있거나 읽기에 실패하면 False 를 돌린다 — 판단이 안 서는데 재색인을
    시작하면 검색이 더 느려지기만 한다. 그 경우는 doctor 가 다룰 문제다.
    """
    root = config.MEMORY_ROOT
    try:
        files = _corpus(root)
        if not files:
            return False
        stored = client.mget([f"{config.HASH_PREFIX}{_file_id(path, root)}" for path in files])
        for path, value in zip(files, stored):
            if value is None:
                return True
            current = _fingerprint(path)
            if value.decode("utf-8", "replace") != current:
                return True
        return False
    except Exception:
        return False


def refresh(quiet: bool = True) -> None:
    """증분 색인을 앞단에서 돌린다(검색이 그 결과를 봐야 하므로 기다린다)."""
    indexer = Path(__file__).resolve().parent / "memory-index.py"
    if not quiet:
        print("색인이 뒤처져 있어 갱신합니다...", file=sys.stderr)
    subprocess.run(
        [sys.executable, str(indexer), "--incremental"],
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.DEVNULL if quiet else None,
        check=False,
    )


def ensure_fresh(client, quiet: bool = True) -> bool:
    """뒤처졌으면 따라잡는다. 갱신을 돌렸으면 True."""
    if not is_stale(client):
        return False
    refresh(quiet=quiet)
    return True
