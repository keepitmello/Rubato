#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import argparse
import re
import sys
import zipfile

RESERVED_NAMES = {"anthropic", "claude"}


def fail(message: str, errors: list[str]) -> None:
    errors.append(message)


def lint(root: Path) -> int:
    errors: list[str] = []
    warnings: list[str] = []
    skill = root / "SKILL.md"
    if not skill.exists():
        fail("SKILL.md is missing", errors)
        return report(errors, warnings)

    text = skill.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        fail("SKILL.md must start with YAML frontmatter", errors)
    parts = text.split("---", 2)
    frontmatter = parts[1] if len(parts) >= 3 else ""
    name_match = re.search(r"^name:\s*([^\n]+)$", frontmatter, re.M)
    desc_match = re.search(r"^description:\s*([^\n]+)$", frontmatter, re.M)
    if not name_match:
        fail("frontmatter name is missing", errors)
    else:
        name = name_match.group(1).strip()
        if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
            fail("name must be 1-64 lowercase letters, digits, or hyphens", errors)
        if any(part in RESERVED_NAMES for part in name.split("-")):
            fail("name contains a reserved word", errors)
        if root.name.lower().replace("_", "-") != name.lower().replace("_", "-"):
            fail("top-level directory must match the frontmatter name", errors)
    if not desc_match or len(desc_match.group(1).strip()) < 80:
        warnings.append("description may be too weak to trigger reliably")

    line_count = len(text.splitlines())
    if line_count > 500:
        warnings.append(f"SKILL.md has {line_count} lines; progressive disclosure is recommended")

    for ref in re.findall(r"`((?:references|templates|tests|scripts)/[^`]+)`", text):
        if not (root / ref).exists():
            fail(f"referenced file does not exist: {ref}", errors)

    must_count = len(re.findall(r"\bMUST\b|\bNEVER\b", text))
    if must_count > 20:
        warnings.append(f"SKILL.md contains {must_count} harsh imperative tokens")

    for path in root.rglob("*"):
        if path.is_file() and path.stat().st_size > 5 * 1024 * 1024:
            warnings.append(f"large file may inflate upload: {path.relative_to(root)}")

    return report(errors, warnings)


def report(errors: list[str], warnings: list[str]) -> int:
    for item in warnings:
        print(f"WARNING: {item}")
    for item in errors:
        print(f"ERROR: {item}")
    if errors:
        print(f"FAIL: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"PASS: 0 errors, {len(warnings)} warning(s)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    args = parser.parse_args()
    return lint(Path(args.root).resolve())


if __name__ == "__main__":
    sys.exit(main())
