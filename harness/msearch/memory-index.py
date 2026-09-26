#!/usr/bin/env python3
"""
Index memory markdown files into Redis Stack.

색인 대상은 메모리 루트 아래 모든 마크다운이다. rubato 메모리에서는 각 저장소의
`repo/` 아래(decisions/, reference/, skills/, system/ …)와 루트 상주 문서
(USER.md 등)가 여기 들어온다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from dotenv import load_dotenv
from konlpy.tag import Okt
from openai import OpenAI
import redis


from msearch_config import (
    CHANNEL_ID,
    CHANNEL_KEY_ID,
    EMBEDDING_MODEL,
    HASH_PREFIX,
    INDEX_NAME,
    KEY_PREFIX,
    MANIFEST_KEY,
    MEMORY_ROOT,
    REDIS_URL,
    STATE_DIR,
)

PROJECT_ROOT = MEMORY_ROOT
load_dotenv(STATE_DIR / ".env")  # OPENAI_API_KEY
FINGERPRINT_VERSION = "channel-v4"

VECTOR_DIM = 1536
MAX_CHUNK_CHARS = 2000
CHUNK_OVERLAP = 200
MIN_CHUNK_CHARS = 40
EMBEDDING_BATCH_SIZE = 64

HANGUL_WORD_RE = re.compile(r"(?<![가-힣])[가-힣]{2,8}(?![가-힣])")
SKIP_SECTION_KEYWORDS = (
    "테스트 결과",
    "테스트 - 문제",
    "테스트 - 완벽",
    "직접 검색",
    "훅에서 -",
    "코덱스 해결책",
    "최종 구현",
)

SLUG_ALIASES = {
    "telegram": "텔레그램",
    "reconnect": "재연결",
    "memory": "기억 메모리",
    "search": "검색",
    "profile": "프로필",
    "finance": "재정 자금",
    "finances": "재정 자금",
}

_okt: Okt | None = None

# 메타 기록(기억에 대한 기억 — 검색 체험·골든셋·시스템 작업) 식별.
# SSOT는 텍스트 마커 + overrides 파일 — 재인덱싱해도 보존된다 (HSET만 치면 재임베딩 때 증발).
META_MARKER = "[메타]"
META_OVERRIDES_PATH = PROJECT_ROOT / "memory" / "meta-overrides.json"
_meta_overrides: set[tuple[str, str]] | None = None


def get_meta_overrides() -> set[tuple[str, str]]:
    global _meta_overrides
    if _meta_overrides is None:
        try:
            entries = json.loads(META_OVERRIDES_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            entries = []
        _meta_overrides = {
            (str(entry.get("rel_path", "")), str(entry.get("section", "")))
            for entry in entries
            if isinstance(entry, dict)
        }
    return _meta_overrides


def meta_flag(relative: str, section: str) -> str:
    if META_MARKER in section:
        return "1"
    return "1" if (relative, section) in get_meta_overrides() else "0"


@dataclass(frozen=True)
class MemoryChunk:
    key: str
    title: str
    section: str
    content: str
    file_path: str
    rel_path: str
    chunk_idx: str
    mtime: float


def get_okt() -> Okt:
    global _okt
    if _okt is None:
        _okt = Okt()
    return _okt


def dedupe_preserve_order(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def tokenize_ko_tokens(text: str) -> list[str]:
    morphs = get_okt().morphs(text, norm=True, stem=True)
    regex_tokens = HANGUL_WORD_RE.findall(text)
    cleaned = [token.strip() for token in morphs + regex_tokens if token.strip()]
    return dedupe_preserve_order(cleaned)


def tokenize_ko(text: str) -> str:
    return " ".join(tokenize_ko_tokens(text))


# 인덱스에서 제외할 경로 조각.
#  · _tech-notes — 기술 메타문서 (기억 아님, 검색 노이즈)
#  · backups — 백업 사본 (중복·노이즈)
#  · .git — 메모리 저장소는 git 레포라 객체/로그가 같이 잎힌다
#  · runtime — 반사 실행 기록·큐·저널 (기억이 아니라 기계 상태)
EXCLUDE_PATH_FRAGMENTS = (
    "_tech-notes/",
    "/backups/",
    "/backup/",
    "/.git/",
    "/runtime/",
)

# 루트 상주 문서 — 매 세션 프롬프트에 주입되는 정본.
# 색인에 없으면 "내 문서에 뭐라고 써 있지"를 검색으로 확인할 통로가 없다 [08-02].
# rubato 메모리에서는 이들이 각 identity 저장소의 repo/system/ 아래 살아서
# 아래 rglob 이 이미 집는다. 다른 레이아웃을 가리킬 때를 위해 남겨둔다.
RESIDENT_DOCS = (
    "USER.md",
    "SOUL.md",
    "MEMORY.md",
    "COMPANION.md",
    "TOOLS.md",
    "IDENTITY.md",
)


def is_excluded(file_path: Path) -> bool:
    normalized = "/" + rel_path(file_path).replace("\\", "/") + "/"
    return any(fragment in normalized for fragment in EXCLUDE_PATH_FRAGMENTS)


def discover_markdown_files() -> list[Path]:
    # 원본은 세 디렉터리를 이름으로 박아둔다. 그것은 채널 레이아웃이 고정이기 때문이었고,
    # 여기서는 루트 아래에 identity 저장소가 몇 개든 생길 수 있다. 루트를 통째로 훑되,
    # 저장소의 .git 과 런타임 산출물은 제외한다.
    source_dirs = [PROJECT_ROOT]
    files: list[Path] = []
    for directory in source_dirs:
        if directory.exists():
            files.extend(
                path for path in directory.rglob("*.md")
                if path.is_file() and not is_excluded(path)
            )
    # 재귀 스캔 금지 — 명시한 루트 문서만.
    files.extend(
        path for name in RESIDENT_DOCS
        if (path := PROJECT_ROOT / name).is_file()
    )
    return sorted(set(files), key=lambda path: rel_path(path))


def rel_path(file_path: Path) -> str:
    resolved = file_path.resolve()
    try:
        return str(resolved.relative_to(PROJECT_ROOT))
    except ValueError:
        # External paths — use home-relative or absolute
        try:
            return str(resolved.relative_to(Path.home()))
        except ValueError:
            return str(resolved)


def file_id(file_path: Path) -> str:
    return hashlib.sha1(rel_path(file_path).encode("utf-8")).hexdigest()[:16]


def file_hash(file_path: Path) -> str:
    return hashlib.sha256(file_path.read_bytes()).hexdigest()


def file_fingerprint(file_path: Path) -> str:
    return f"{FINGERPRINT_VERSION}:{file_hash(file_path)}"


def stored_hash_key(file_path: Path) -> str:
    return f"{HASH_PREFIX}{file_id(file_path)}"


def chunk_key(file_path: Path, chunk_idx: str) -> str:
    return f"{KEY_PREFIX}{file_id(file_path)}:{chunk_idx}"


def split_large_section(section_content: str) -> list[str]:
    if len(section_content) <= MAX_CHUNK_CHARS:
        return [section_content]

    chunks: list[str] = []
    step = MAX_CHUNK_CHARS - CHUNK_OVERLAP
    for start in range(0, len(section_content), step):
        piece = section_content[start:start + MAX_CHUNK_CHARS].strip()
        if len(piece) >= MIN_CHUNK_CHARS:
            chunks.append(piece)
    return chunks


def extract_title(content: str, file_path: Path) -> str:
    match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    return match.group(1).strip() if match else file_path.stem


def metadata_terms(file_path: Path) -> str:
    parts = re.split(r"[-_/\s.]+", rel_path(file_path).lower())
    aliases = [SLUG_ALIASES[part] for part in parts if part in SLUG_ALIASES]
    return " ".join(dedupe_preserve_order(parts + aliases))


def chunk_markdown(content: str, file_path: Path) -> list[MemoryChunk]:
    title = extract_title(content, file_path)
    sections = re.split(r"\n##\s+", content)
    chunks: list[MemoryChunk] = []
    mtime = file_path.stat().st_mtime
    relative = rel_path(file_path)

    for section_idx, section in enumerate(sections):
        if section_idx == 0:
            section_title = ""
            section_content = re.sub(r"^#\s+.+\n?", "", section).strip()
        else:
            parts = section.split("\n", 1)
            section_title = parts[0].strip()
            section_content = parts[1].strip() if len(parts) > 1 else ""

        if not section_content or len(section_content) < MIN_CHUNK_CHARS:
            continue
        if any(keyword in section_title for keyword in SKIP_SECTION_KEYWORDS):
            continue

        for part_idx, part in enumerate(split_large_section(section_content)):
            chunk_idx = f"{section_idx}-{part_idx}" if len(section_content) > MAX_CHUNK_CHARS else str(section_idx)
            chunks.append(
                MemoryChunk(
                    key=chunk_key(file_path, chunk_idx),
                    title=title,
                    section=section_title,
                    content=part,
                    file_path=str(file_path.resolve()),
                    rel_path=relative,
                    chunk_idx=chunk_idx,
                    mtime=mtime,
                )
            )
    return chunks


def vector_to_bytes(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


def embedding_inputs(chunks: list[MemoryChunk]) -> list[str]:
    return [
        f"{chunk.title}\n{chunk.section}\n{chunk.rel_path}\n{metadata_terms(Path(chunk.file_path))}\n---\n{chunk.content}"[:8000]
        for chunk in chunks
    ]


def get_embeddings(client: OpenAI, texts: list[str]) -> list[list[float]]:
    embeddings: list[list[float]] = []
    for start in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[start:start + EMBEDDING_BATCH_SIZE]
        response = client.embeddings.create(model=EMBEDDING_MODEL, input=batch)
        embeddings.extend(item.embedding for item in response.data)
    return embeddings


def delete_keys_by_pattern(r: redis.Redis, pattern: str) -> int:
    cursor = 0
    deleted = 0
    while True:
        cursor, keys = r.scan(cursor, match=pattern, count=500)
        if keys:
            deleted += len(keys)
            r.delete(*keys)
        if cursor == 0:
            return deleted


def delete_file_chunks(r: redis.Redis, file_path: Path) -> int:
    return delete_keys_by_pattern(r, f"{KEY_PREFIX}{file_id(file_path)}:*")


def create_index(r: redis.Redis, drop_existing: bool) -> None:
    if drop_existing:
        print("channel keys reset requested; shared RediSearch index is preserved")
        delete_keys_by_pattern(r, f"{KEY_PREFIX}*")
        delete_keys_by_pattern(r, f"{HASH_PREFIX}*")
        r.delete(MANIFEST_KEY)

    try:
        r.execute_command("FT.INFO", INDEX_NAME)
        ensure_channel_schema(r)
        return
    except redis.ResponseError:
        pass

    r.execute_command(
        "FT.CREATE", INDEX_NAME,
        "ON", "HASH",
        "PREFIX", "1", KEY_PREFIX,
        "STOPWORDS", "0",
        "SCHEMA",
        "content_tokenized", "TEXT", "NOSTEM", "WEIGHT", "3.0",
        "title", "TEXT", "WEIGHT", "5.0",
        "section", "TEXT", "WEIGHT", "2.0",
        "content", "TEXT", "NOINDEX",
        "channel", "TAG",
        "rel_path", "TAG",
        "meta", "TAG",
        "mtime", "NUMERIC",
        "file_path", "TEXT", "NOINDEX",
        "chunk_idx", "TAG",
        "vector", "VECTOR", "HNSW", "6",
        "TYPE", "FLOAT32",
        "DIM", str(VECTOR_DIM),
        "DISTANCE_METRIC", "COSINE",
    )
    print(f"인덱스 생성: {INDEX_NAME}")


def ensure_channel_schema(r: redis.Redis) -> None:
    for field, field_type in (
        ("channel", "TAG"),
        ("meta", "TAG"),
    ):
        try:
            r.execute_command("FT.ALTER", INDEX_NAME, "SCHEMA", "ADD", field, field_type)
            print(f"schema field added: {field} {field_type} on {INDEX_NAME}")
        except redis.ResponseError as exc:
            message = str(exc).lower()
            if "already" in message or "exists" in message or "duplicate" in message:
                continue
            raise


def index_file(file_path: Path, r: redis.Redis, client: OpenAI) -> int:
    content = file_path.read_text(encoding="utf-8")
    chunks = chunk_markdown(content, file_path)
    delete_file_chunks(r, file_path)

    if not chunks:
        r.set(stored_hash_key(file_path), file_fingerprint(file_path))
        r.sadd(MANIFEST_KEY, rel_path(file_path))
        return 0

    embeddings = get_embeddings(client, embedding_inputs(chunks))
    pipe = r.pipeline(transaction=False)
    for chunk, embedding in zip(chunks, embeddings, strict=True):
        bm25_text = f"{chunk.title}\n{chunk.section}\n{chunk.rel_path}\n{metadata_terms(file_path)}\n{chunk.content}"
        pipe.hset(
            chunk.key,
            mapping={
                "content_tokenized": tokenize_ko(bm25_text),
                "title": chunk.title,
                "section": chunk.section,
                "content": chunk.content,
                "channel": CHANNEL_ID,
                "rel_path": chunk.rel_path,
                "meta": meta_flag(chunk.rel_path, chunk.section),
                "mtime": chunk.mtime,
                "file_path": chunk.file_path,
                "chunk_idx": chunk.chunk_idx,
            },
        )
        pipe.hset(chunk.key, "vector", vector_to_bytes(embedding))

    pipe.set(stored_hash_key(file_path), file_fingerprint(file_path))
    pipe.sadd(MANIFEST_KEY, rel_path(file_path))
    pipe.execute()
    return len(chunks)


def cleanup_deleted_files(r: redis.Redis, current_files: set[str]) -> int:
    stored = r.smembers(MANIFEST_KEY)
    deleted_chunks = 0
    for item in stored:
        stored_rel = item.decode("utf-8") if isinstance(item, bytes) else item
        if stored_rel in current_files:
            continue
        fake_path = PROJECT_ROOT / stored_rel
        deleted_chunks += delete_file_chunks(r, fake_path)
        r.delete(stored_hash_key(fake_path))
        r.srem(MANIFEST_KEY, stored_rel)

    cursor = 0
    while True:
        cursor, keys = r.scan(cursor, match=f"{KEY_PREFIX}*", count=500)
        for key in keys:
            key_text = key.decode("utf-8") if isinstance(key, bytes) else key
            if key_text == MANIFEST_KEY:
                continue
            key_type = r.type(key)
            if key_type not in (b"hash", "hash"):
                continue
            rel_value = r.hget(key, "rel_path")
            key_rel = rel_value.decode("utf-8") if isinstance(rel_value, bytes) else rel_value
            if key_rel and key_rel in current_files:
                continue
            r.delete(key)
            deleted_chunks += 1
        if cursor == 0:
            break

    return deleted_chunks


def heal_tags(r: redis.Redis) -> int:
    """재임베딩 없이 파생 TAG(meta)를 현재 규칙에 맞춘다 (HSET만, idempotent).

    파일이 안 바뀌면 인덱싱이 스킵되므로, meta-overrides 추가분은 매 실행 여기서 따라잡는다.
    """
    override_rels = {rel for rel, _ in get_meta_overrides()}
    healed = 0
    for rel in sorted(override_rels):
        path = PROJECT_ROOT / rel
        cursor = 0
        pattern = f"{KEY_PREFIX}{file_id(path)}:*"
        while True:
            cursor, keys = r.scan(cursor, match=pattern, count=200)
            for key in keys:
                section_raw = r.hget(key, "section")
                section = section_raw.decode("utf-8") if isinstance(section_raw, bytes) else (section_raw or "")
                if meta_flag(rel, section) != "1":
                    continue
                meta_raw = r.hget(key, "meta")
                meta_text = meta_raw.decode("utf-8") if isinstance(meta_raw, bytes) else (meta_raw or "")
                if meta_text == "1":
                    continue
                r.hset(key, mapping={"meta": "1"})
                healed += 1
            if cursor == 0:
                break
    return healed


def should_index(file_path: Path, r: redis.Redis, incremental: bool) -> bool:
    if not incremental:
        return True
    stored = r.get(stored_hash_key(file_path))
    stored_text = stored.decode("utf-8") if isinstance(stored, bytes) else stored
    return stored_text != file_fingerprint(file_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Index memories into Redis Stack")
    parser.add_argument("--incremental", "-i", action="store_true", help="index only changed files")
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="delete indexed keys and rebuild documents; preserve shared RediSearch index",
    )
    parser.add_argument("--dry-run", action="store_true", help="show files that would be indexed")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    files = discover_markdown_files()
    current_rel_paths = {rel_path(path) for path in files}

    print(f"memory indexing: {PROJECT_ROOT}")
    print(f"Redis: {REDIS_URL} | index: {INDEX_NAME} | files: {len(files)}")

    if args.dry_run:
        for path in files:
            print(rel_path(path))
        return 0

    r = redis.from_url(REDIS_URL, decode_responses=False)
    r.ping()
    create_index(r, drop_existing=args.force)

    deleted_chunks = cleanup_deleted_files(r, current_rel_paths) if args.incremental else 0
    if deleted_chunks:
        print(f"deleted stale chunks: {deleted_chunks}")

    client = OpenAI()
    processed = 0
    skipped = 0
    total_chunks = 0
    failures: list[str] = []

    for path in files:
        if not should_index(path, r, args.incremental):
            skipped += 1
            continue
        try:
            chunks = index_file(path, r, client)
            processed += 1
            total_chunks += chunks
            print(f"indexed {rel_path(path)} ({chunks} chunks)")
        except Exception as exc:
            failures.append(f"{rel_path(path)}: {exc}")
            print(f"failed {rel_path(path)}: {exc}", file=sys.stderr)

    healed = heal_tags(r)
    if healed:
        print(f"healed tags (meta): {healed}")

    print(f"done: processed={processed}, skipped={skipped}, chunks={total_chunks}, failures={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
