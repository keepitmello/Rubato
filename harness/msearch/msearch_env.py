#!/usr/bin/env python3
"""msearch Python 환경이 저장소의 잠금과 정확히 같은지 판정한다."""

from __future__ import annotations

import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

LOCK = Path(__file__).with_name("requirements.lock")
RUNTIME_LOCK = Path(__file__).with_name("runtime.lock")


def runtime_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for raw in RUNTIME_LOCK.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, pinned = line.split("=", 1)
        versions[name] = pinned
    return versions


def expected_packages() -> dict[str, str]:
    expected: dict[str, str] = {}
    for raw in LOCK.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, pinned = line.split("==", 1)
        expected[name] = pinned
    return expected


def problems() -> list[str]:
    found: list[str] = []
    expected_python = runtime_versions()["PYTHON_VERSION"]
    actual_python = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if actual_python != expected_python:
        found.append(
            f"Python {expected_python} 필요, 현재 {actual_python}"
        )
    for package, expected in expected_packages().items():
        try:
            actual = version(package)
        except PackageNotFoundError:
            found.append(f"{package} 없음 (필요 {expected})")
            continue
        if actual != expected:
            found.append(f"{package} {actual} (필요 {expected})")
    return found


def main() -> int:
    found = problems()
    if found:
        print("\n".join(found))
        return 1
    print(f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro} + requirements.lock 일치")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
