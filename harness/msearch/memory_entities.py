#!/usr/bin/env python3
"""Entity alias and lookup helpers for memory retrieval."""

from __future__ import annotations

import re
from pathlib import Path

from msearch_config import MEMORY_ROOT


# 인물 별칭 사전. rubato 메모리에서는 people/ 가 그 자리라 둘 다 본다 —
# 없으면 별칭 확장만 안 될 뿐 검색은 그대로 돌아간다.
PROJECT_ROOT = MEMORY_ROOT
ENTITY_DIR = PROJECT_ROOT / "entities"
ALIASES_PATH = ENTITY_DIR / "aliases.md"

ENTITY_LOOKUP_RE = re.compile(
    r"누구|누구야|프로필|성향|기억나|기억나니|뭐였지|뭐였더라|어떤\s*사람|관계|정리|뭐\s*하셔|뭐\s*하시|뭐\s*해|직업|근황"
)
ENTITY_RELATION_RE = re.compile(
    r"여사친|남사친|친구|지인|동료|선배|후배|전남친|전여친|관계"
)
FAMILY_LOOKUP_RE = re.compile(
    r"누구|프로필|성향|기억나|기억나니|뭐였지|뭐였더라|어떤\s*사람|뭐\s*하셔|뭐\s*하시|뭐\s*해|직업|근황"
)
FAMILY_TERMS = ("엄마", "아빠", "동생")
ACTION_QUERY_RE = re.compile(
    r"후속|다음에|해야|해야\s*할|할일|챙겨|챙기|하자|해보자|남았|급한|리마인드|결정|약속|수술|고치|작업|진행"
)

HANGUL_RE = re.compile(r"^[가-힣]+$")
SHORT_ALIAS_PARTICLES = (
    "한테",
    "에게",
    "하고",
    "이랑",
    "가",
    "이",
    "은",
    "는",
    "을",
    "를",
    "의",
    "에",
    "로",
    "와",
    "과",
    "랑",
    "야",
    "만",
    "네",
    "씨",
)
SINGLE_SYLLABLE_ALIAS_PARTICLES = tuple(
    particle for particle in SHORT_ALIAS_PARTICLES if particle not in {"과"}
)
SHORT_ALIAS_PARTICLES_WITH_DO = SHORT_ALIAS_PARTICLES + ("도",)

CURRENT_SECTION_HEADINGS = {"지금", "사실", "사실 / 프로필", "프로필"}
STORY_SECTION_HEADINGS = {"이야기", "결"}
FANTASY_SECTION_RE = re.compile(r"소재|상상")
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)


def load_alias_map() -> dict[str, str]:
    """Parse memory/entities/aliases.md table as alias -> canonical."""
    try:
        text = ALIASES_PATH.read_text(encoding="utf-8")
    except OSError:
        return {}

    aliases: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not (line.startswith("|") and line.endswith("|")):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        alias_cell, canonical = cells[0], cells[1]
        if alias_cell in {"표기 / 별칭", "-------------"} or not canonical or "---" in canonical:
            continue
        for alias in re.split(r"[,/、]", alias_cell):
            alias = alias.strip()
            if alias:
                aliases[alias] = canonical
        aliases[canonical] = canonical
    return aliases


def _alias_pattern(alias: str) -> re.Pattern[str]:
    escaped = re.escape(alias)
    if len(alias) <= 2 and HANGUL_RE.fullmatch(alias):
        # Short Korean aliases are high-risk: "효도"/"효과" are ordinary words,
        # not necessarily "효"+"도/과". Keep those particles only for 2-syllable
        # aliases where the false-positive risk is much lower.
        particles = (
            SHORT_ALIAS_PARTICLES_WITH_DO
            if len(alias) > 1
            else SINGLE_SYLLABLE_ALIAS_PARTICLES
        )
        particle_pattern = "|".join(
            re.escape(particle) for particle in sorted(particles, key=len, reverse=True)
        )
        return re.compile(
            rf"(?<![가-힣]){escaped}(?:(?:{particle_pattern})(?![가-힣])|(?![가-힣]))"
        )
    return re.compile(rf"(?<![가-힣]){escaped}(?![가-힣])")


def canonical_hits(query: str) -> list[str]:
    hits: list[str] = []
    for alias, canonical in load_alias_map().items():
        if _alias_pattern(alias).search(query) and canonical not in hits:
            hits.append(canonical)
    if is_family_lookup_query(query) and "가족" not in hits:
        hits.append("가족")
    return hits


def is_family_lookup_query(query: str) -> bool:
    return bool(FAMILY_LOOKUP_RE.search(query)) and any(
        _alias_pattern(term).search(query) for term in FAMILY_TERMS
    )


def expand_entity_aliases(query: str) -> str:
    """Append canonical entity names so Redis BM25/vector see the stable name."""
    additions = [canonical for canonical in canonical_hits(query) if canonical not in query]
    if not additions:
        return query
    return f"{query}\n{' '.join(additions)}"


def is_entity_lookup_query(query: str) -> bool:
    return bool(canonical_hits(query)) and bool(
        ENTITY_LOOKUP_RE.search(query) or ENTITY_RELATION_RE.search(query)
    )


def is_action_query(query: str) -> bool:
    return bool(ACTION_QUERY_RE.search(query))


def frontmatter_value(content: str, key: str) -> str:
    match = FRONTMATTER_RE.match(content)
    if not match:
        return ""
    key_pattern = re.escape(key)
    value_match = re.search(rf"^{key_pattern}:\s*(.+?)\s*$", match.group(1), re.MULTILINE)
    if not value_match:
        return ""
    return value_match.group(1).strip().strip("\"'")


def entity_canonical(rel_path: str, content: str) -> str:
    if not rel_path.startswith("memory/entities/"):
        return ""
    if rel_path.endswith("/aliases.md") or rel_path == "memory/entities/aliases.md":
        return ""
    canonical = frontmatter_value(content, "canonical")
    if canonical:
        return canonical
    return Path(rel_path).stem


def entity_subtype(rel_path: str, section: str) -> str:
    if not rel_path.startswith("memory/entities/"):
        return ""
    if rel_path.endswith("/aliases.md") or rel_path == "memory/entities/aliases.md":
        return "entity_alias"
    normalized = re.sub(r"\s+", " ", section).strip()
    if normalized in CURRENT_SECTION_HEADINGS:
        return "entity_current"
    if normalized in STORY_SECTION_HEADINGS:
        return "entity_story"
    if FANTASY_SECTION_RE.search(normalized):
        return "entity_fantasy"
    return "entity_intro"
