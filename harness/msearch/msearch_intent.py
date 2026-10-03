"""합의 기록(intent)을 기억 옆에서 찾는다.

기억 저장소의 `store.json` 은 그 저장소를 쓰는 프로젝트 루트들(`roots`)을 들고 있고, 각
루트의 `intent/<id>/intent.md` 가 그 프로젝트의 합의 기록이다. 형식의 정본은 work-intent
스킬(`scripts/intent.mjs`)이고, 여기서는 읽기만 한다.

기억과 같은 랭킹에 섞지 않는다. 기억은 지금의 답이고 intent 는 한 변경 때의 합의라서,
섞으면 옛 합의가 지금 답과 다투는 것처럼 읽힌다. 그래서 인덱스·키·출력 블록을 따로 두고,
출력 줄마다 상태와 날짜를 붙여 그 시점의 기록으로 읽히게 한다.

표준 라이브러리만 쓴다. Redis 클라이언트·임베딩·토크나이저는 호출자가 넘긴다 — 그래야
검색 의존성 없이 시험할 수 있다.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

import msearch_config as config

FINGERPRINT_VERSION = "intent-v1"
STORE_FILE = "store.json"
INTENT_HOME = "intent"
INTENT_FILE = "intent.md"

STATUSES = ("draft", "active", "fulfilled", "abandoned", "superseded")
PAST_STATUSES = frozenset({"fulfilled", "abandoned", "superseded"})

VECTOR_DIM = 1536
MAX_CHUNK_CHARS = 2000
CHUNK_OVERLAP = 200
MIN_CHUNK_CHARS = 40

# 관련성 문턱. 헛걸린 합의 기록 하나가 아무것도 안 보여주는 것보다 해로워서 어휘와 의미를
# 함께 요구한다. 값은 실제 intent 18건(183조각)에 질의를 돌려 맞췄다: 맞는 기록은 거리
# 0.70~0.73 에 희소도 가중 겹침 0.35 이상, 흔한 단어로 걸린 기록은 거리 0.77 이상이었다.
MIN_TOKEN_HITS = 2
MIN_TOKEN_OVERLAP = 0.34
MAX_VECTOR_DISTANCE = 0.5
LEXICAL_MAX_DISTANCE = 0.75
DISTINCTIVE_SHARE = 1 / 3
RETURN_K = 3
EXCERPT_CHARS = 220

BLOCK_HEADER = "=== 합의 기록 (intent) — 기억과 따로 찾은 것"
BLOCK_NOTE = (
    "한 변경에서 사용자가 원하고 합의한 기록이다. 상태와 날짜가 그 합의의 시점을 말한다.\n"
    "지금의 답은 기억이다. 지난 기록은 그때의 합의일 뿐, 기억을 고치는 말이 아니다."
)


# ── 기록 읽기 ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IntentMeta:
    intent_id: str
    status: str
    revision: str
    updated: str
    superseded_by: str
    title: str


def parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
    """intent.mjs 의 decode 와 같은 부분집합: 줄마다 스칼라 하나, 값은 JSON 리터럴.

    검증은 하지 않는다. 형식이 깨진 기록도 찾아져야 하고, 판정은 intent.mjs 의 몫이다.
    """
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text.replace("\r\n", "\n"), re.S)
    if not match:
        return {}, text
    meta: dict[str, object] = {}
    for line in match.group(1).split("\n"):
        pair = re.match(r"^([a-z_][a-z_0-9]*):\s*(.+)$", line)
        if not pair:
            continue
        try:
            meta[pair.group(1)] = json.loads(pair.group(2))
        except ValueError:
            meta[pair.group(1)] = pair.group(2)
    return meta, match.group(2)


def _scalar(value: object) -> str:
    return "" if value is None else str(value)


def read_meta(text: str, path: Path) -> tuple[IntentMeta, str]:
    meta, body = parse_frontmatter(text)
    title_match = re.search(r"^#\s+(?:Intent:\s*)?(.+)$", body, re.M)
    status = _scalar(meta.get("status")).strip()
    return (
        IntentMeta(
            intent_id=_scalar(meta.get("id")).strip() or path.parent.name,
            status=status if status in STATUSES else "unknown",
            revision=_scalar(meta.get("revision")).strip() or "?",
            updated=_scalar(meta.get("updated") or meta.get("created")).strip(),
            superseded_by=_scalar(meta.get("superseded_by")).strip(),
            title=title_match.group(1).strip() if title_match else path.parent.name,
        ),
        body,
    )


# ── 어디서 찾나 ──────────────────────────────────────────────────────────────


def store_roots(agents_dir: Path, store: str | None = None) -> list[Path]:
    """저장소(없으면 전체)의 store.json `roots`. 아무것도 만들지 않는다."""
    if store is not None:
        stores = [agents_dir / store]
    else:
        try:
            stores = sorted(entry for entry in agents_dir.iterdir() if entry.is_dir())
        except OSError:
            stores = []
    roots: list[Path] = []
    for directory in stores:
        try:
            record = json.loads((directory / STORE_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        values = record.get("roots") if isinstance(record, dict) else None
        for value in values if isinstance(values, list) else []:
            if isinstance(value, str) and value:
                root = Path(os.path.realpath(value))
                if root not in roots:
                    roots.append(root)
    return roots


def discover(roots: Iterable[Path]) -> list[Path]:
    """루트마다 `intent/<id>/intent.md`. 링크는 따라가지 않는다 (intent.mjs 와 같은 규칙)."""
    found: list[Path] = []
    for root in roots:
        home = root / INTENT_HOME
        if home.is_symlink() or not home.is_dir():
            continue
        try:
            entries = sorted(home.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
                continue
            path = entry / INTENT_FILE
            if path.is_file() and not path.is_symlink() and path not in found:
                found.append(path)
    return found


def corpus(agents_dir: Path | None = None) -> list[Path]:
    """색인 대상: 모든 저장소의 모든 루트의 intent. 검색이 저장소 루트로 좁힌다."""
    return discover(store_roots(agents_dir if agents_dir is not None else config.MEMORY_ROOT))


def root_of(path: Path) -> Path:
    return path.parent.parent.parent


def root_id(root: Path) -> str:
    return hashlib.sha1(str(root).encode("utf-8")).hexdigest()[:12]


def file_id(path: Path) -> str:
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:16]


def fingerprint(path: Path) -> str:
    return f"{FINGERPRINT_VERSION}:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def hash_key(path: Path) -> str:
    return f"{config.INTENT_HASH_PREFIX}{file_id(path)}"


# ── 조각내기 ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IntentChunk:
    key: str
    meta: IntentMeta
    section: str
    content: str
    path: str
    root_id: str
    chunk_idx: str

    def embedding_input(self) -> str:
        return f"{self.meta.title}\n{self.section}\n---\n{self.content}"[:8000]

    def lexical_text(self) -> str:
        return f"{self.meta.title}\n{self.section}\n{self.content}"


def _split(content: str) -> list[str]:
    if len(content) <= MAX_CHUNK_CHARS:
        return [content]
    step = MAX_CHUNK_CHARS - CHUNK_OVERLAP
    pieces = [content[start:start + MAX_CHUNK_CHARS].strip() for start in range(0, len(content), step)]
    return [piece for piece in pieces if len(piece) >= MIN_CHUNK_CHARS]


def chunk(path: Path) -> list[IntentChunk]:
    meta, body = read_meta(path.read_text(encoding="utf-8"), path)
    chunks: list[IntentChunk] = []
    for section_idx, section in enumerate(re.split(r"\n##\s+", body)):
        if section_idx == 0:
            title, content = "", re.sub(r"^\s*#\s+.+\n?", "", section).strip()
        else:
            head, _, rest = section.partition("\n")
            title, content = head.strip(), rest.strip()
        if len(content) < MIN_CHUNK_CHARS:
            continue
        pieces = _split(content)
        for part_idx, piece in enumerate(pieces):
            chunk_idx = f"{section_idx}-{part_idx}" if len(pieces) > 1 else str(section_idx)
            chunks.append(
                IntentChunk(
                    key=f"{config.INTENT_KEY_PREFIX}{file_id(path)}:{chunk_idx}",
                    meta=meta,
                    section=title,
                    content=piece,
                    path=str(path),
                    root_id=root_id(root_of(path)),
                    chunk_idx=chunk_idx,
                )
            )
    return chunks


# ── 색인 ─────────────────────────────────────────────────────────────────────


def ensure_index(r) -> None:
    """intent 전용 인덱스가 없으면 만든다. 기억 인덱스는 건드리지 않는다."""
    try:
        r.execute_command("FT.INFO", config.INTENT_INDEX_NAME)
        return
    except Exception as exc:  # redis.ResponseError — 여기서는 redis 를 import 하지 않는다
        if "unknown index" not in str(exc).lower() and "no such index" not in str(exc).lower():
            raise
    r.execute_command(
        "FT.CREATE", config.INTENT_INDEX_NAME,
        "ON", "HASH",
        "PREFIX", "1", config.INTENT_KEY_PREFIX,
        "STOPWORDS", "0",
        "SCHEMA",
        "content_tokenized", "TEXT", "NOSTEM", "WEIGHT", "3.0",
        "title", "TEXT", "WEIGHT", "5.0",
        "section", "TEXT", "WEIGHT", "2.0",
        "content", "TEXT", "NOINDEX",
        "root_id", "TAG",
        "status", "TAG",
        "intent_id", "TAG",
        "vector", "VECTOR", "HNSW", "6",
        "TYPE", "FLOAT32",
        "DIM", str(VECTOR_DIM),
        "DISTANCE_METRIC", "COSINE",
    )


def _delete_pattern(r, pattern: str) -> int:
    deleted = 0
    for key in list(r.scan_iter(match=pattern, count=500)):
        r.delete(key)
        deleted += 1
    return deleted


def _decode(value) -> str:
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)


def index(
    r,
    embed: Callable[[list[str]], list[list[float]]],
    tokenize: Callable[[str], str],
    incremental: bool,
    agents_dir: Path | None = None,
    log: Callable[[str], None] = print,
) -> tuple[int, list[str]]:
    """바뀐 intent 만(incremental) 또는 전부 다시 색인한다. (색인한 파일 수, 실패) 를 돌린다."""
    files = corpus(agents_dir)
    live = {str(path) for path in files}
    if not incremental:
        _delete_pattern(r, f"{config.INTENT_KEY_PREFIX}*")
        _delete_pattern(r, f"{config.INTENT_HASH_PREFIX}*")
        r.delete(config.INTENT_MANIFEST_KEY)
    ensure_index(r)

    for stored in r.smembers(config.INTENT_MANIFEST_KEY):
        gone = _decode(stored)
        if gone in live:
            continue
        _delete_pattern(r, f"{config.INTENT_KEY_PREFIX}{file_id(Path(gone))}:*")
        r.delete(hash_key(Path(gone)))
        r.srem(config.INTENT_MANIFEST_KEY, gone)
        log(f"removed intent {gone}")

    processed = 0
    failures: list[str] = []
    for path in files:
        current = fingerprint(path)
        if incremental:
            stored = r.get(hash_key(path))
            if stored is not None and _decode(stored) == current:
                continue
        try:
            chunks = chunk(path)
            vectors = embed([item.embedding_input() for item in chunks]) if chunks else []
            _delete_pattern(r, f"{config.INTENT_KEY_PREFIX}{file_id(path)}:*")
            pipe = r.pipeline(transaction=False)
            for item, vector in zip(chunks, vectors, strict=True):
                pipe.hset(
                    item.key,
                    mapping={
                        "content_tokenized": tokenize(item.lexical_text()),
                        "title": item.meta.title,
                        "section": item.section,
                        "content": item.content,
                        "intent_id": item.meta.intent_id,
                        "status": item.meta.status,
                        "revision": item.meta.revision,
                        "updated": item.meta.updated,
                        "superseded_by": item.meta.superseded_by,
                        "path": item.path,
                        "root_id": item.root_id,
                        "chunk_idx": item.chunk_idx,
                        "vector": struct.pack(f"{len(vector)}f", *vector),
                    },
                )
            pipe.set(hash_key(path), current)
            pipe.sadd(config.INTENT_MANIFEST_KEY, str(path))
            pipe.execute()
            processed += 1
            log(f"indexed intent {path} ({len(chunks)} chunks)")
        except Exception as exc:
            failures.append(f"{path}: {exc}")
            log(f"failed intent {path}: {exc}")
    return processed, failures


def is_stale(r, agents_dir: Path | None = None) -> bool:
    """색인의 intent 가 디스크와 어긋났으면 True. 지문 대조만 하는 로컬 비교다."""
    files = corpus(agents_dir)
    indexed = {_decode(item) for item in r.smembers(config.INTENT_MANIFEST_KEY)}
    if indexed - {str(path) for path in files}:
        return True
    if not files:
        return False
    stored = r.mget([hash_key(path) for path in files])
    return any(value is None or _decode(value) != fingerprint(path) for path, value in zip(files, stored))


# ── 찾기 ─────────────────────────────────────────────────────────────────────


@dataclass
class Candidate:
    fields: dict[str, str]
    distance: float | None = None
    hits: list[str] = field(default_factory=list)
    overlap: float = 0.0
    score: float = 0.0


def _root_filter(root_ids: list[str] | None) -> str:
    if not root_ids:
        return "*"
    return "@root_id:{" + "|".join(root_ids) + "}"


def _parse(reply) -> list[dict[str, str]]:
    """FT.SEARCH 응답(평평한 배열이든 redis-py 8 의 map 이든)을 필드 dict 목록으로."""
    docs: list[dict[str, str]] = []
    if isinstance(reply, dict):
        results = reply.get("results") or reply.get(b"results") or []
        for item in results:
            attrs = item.get("extra_attributes") or item.get(b"extra_attributes") or {}
            docs.append({_decode(k): _decode(v) for k, v in attrs.items()})
        return docs
    for index in range(2, len(reply or []), 2):
        values = reply[index]
        docs.append({_decode(values[i]): _decode(values[i + 1]) for i in range(0, len(values), 2)})
    return docs


RETURN_FIELDS = ("title", "section", "content", "intent_id", "status", "revision", "updated", "superseded_by", "path")
#: 범위 안 조각을 통째로 읽는 상한. 지금 intent 18건이 183조각이다.
MAX_CHUNKS = 5000


def search(
    r,
    tokens: list[str],
    query_vector: Callable[[], bytes | None],
    root_ids: list[str] | None,
    limit: int = RETURN_K,
) -> list[Candidate]:
    """범위 안의 조각을 전부 읽어 어휘·벡터 증거를 붙이고 `select` 로 고른다.

    intent 는 프로젝트당 수십 건이라 통째로 읽어도 싸다. 그래야 단어 희소도를 범위 안
    intent 전체로 잴 수 있다 — BM25 상위만 보면 흔한 단어가 희귀해 보인다.
    """
    scope = _root_filter(root_ids)
    reply = r.execute_command(
        "FT.SEARCH", config.INTENT_INDEX_NAME, scope,
        "RETURN", str(len(RETURN_FIELDS)), *RETURN_FIELDS,
        "LIMIT", "0", str(MAX_CHUNKS), "DIALECT", "2",
    )
    candidates = [Candidate(fields=doc) for doc in _parse(reply)]
    vector = query_vector()
    if vector is not None and candidates:
        reply = r.execute_command(
            "FT.SEARCH", config.INTENT_INDEX_NAME,
            f"({scope})=>[KNN {len(candidates)} @vector $vec AS distance]",
            "PARAMS", "2", "vec", vector,
            "RETURN", "3", "path", "section", "distance",
            "LIMIT", "0", str(len(candidates)), "DIALECT", "2",
        )
        distances = {}
        for doc in _parse(reply):
            try:
                distances[(doc.get("path"), doc.get("section"))] = float(doc.get("distance", ""))
            except ValueError:
                continue
        for item in candidates:
            item.distance = distances.get((item.fields.get("path"), item.fields.get("section")))
    return select(candidates, tokens, limit)


def _token_in(token: str, text: str) -> bool:
    # 한글은 조사가 붙으므로 부분 일치로, 라틴·숫자는 단어 경계로 본다 ("pi" 가 "api" 에 걸리지 않게).
    if re.fullmatch(r"[가-힣]+", token):
        return token in text
    return re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", text) is not None


def _predicate(token: str) -> bool:
    return len(token) >= 2 and re.fullmatch(r"[가-힣]+다", token) is not None


def select(candidates: list[Candidate], tokens: list[str], limit: int = RETURN_K) -> list[Candidate]:
    """문턱을 넘은 조각만, intent 하나당 하나, 점수순으로.

    어휘 겹침은 범위 안 intent 사이의 희소도로 무게를 준다. 흔한 단어("모델", "작업")
    두 개가 겹친 것은 증거가 아니다. 어휘만으로도 부족하다 — 겹치되 의미도 너무 멀지
    않아야(LEXICAL_MAX_DISTANCE) 하고, 의미가 아주 가까우면(MAX_VECTOR_DISTANCE) 그것만으로 된다.
    """
    lowered = dedupe([token.lower() for token in tokens if len(token) > 1])
    by_intent: dict[str, str] = {}
    for item in candidates:
        owner = item.fields.get("path", "")
        text = "\n".join(item.fields.get(name, "") for name in ("title", "section", "content")).lower()
        by_intent[owner] = by_intent.get(owner, "") + "\n" + text
    total = max(len(by_intent), 1)
    spread = {token: sum(_token_in(token, text) for text in by_intent.values()) for token in lowered}
    weight = {token: math.log((total + 1) / (spread[token] + 0.5)) for token in lowered}
    # 가중 겹침은 질의 안에서의 비율이라, 질의가 흔한 단어뿐이면 그래도 1.0 이 된다.
    # 그래서 걸린 단어 중 하나는 범위 안 intent 의 일부(DISTINCTIVE_SHARE)에만 있어야 한다.
    # `-다` 로 끝나는 서술어("읽는다")는 드물어도 주제를 가리키지 않아 그 자격에서 뺀다.
    distinctive = {
        token
        for token in lowered
        if spread[token] <= max(1.0, total * DISTINCTIVE_SHARE) and not _predicate(token)
    }
    whole = sum(weight.values())

    best: dict[str, Candidate] = {}
    for item in candidates:
        text = "\n".join(item.fields.get(name, "") for name in ("title", "section", "content")).lower()
        item.hits = [token for token in lowered if _token_in(token, text)]
        item.overlap = sum(weight[token] for token in item.hits) / whole if whole > 0 else 0.0
        enough_hits = bool(item.hits) and len(item.hits) >= min(MIN_TOKEN_HITS, len(lowered))
        near = item.distance is not None and item.distance <= LEXICAL_MAX_DISTANCE
        lexical = (
            enough_hits and item.overlap >= MIN_TOKEN_OVERLAP and near and any(token in distinctive for token in item.hits)
        )
        semantic = item.distance is not None and item.distance <= MAX_VECTOR_DISTANCE
        if not (lexical or semantic):
            continue
        closeness = 0.0 if item.distance is None else max(0.0, 1.0 - item.distance)
        item.score = item.overlap * 5.0 + closeness * 5.0
        owner = item.fields.get("path", "")
        if owner not in best or item.score > best[owner].score:
            best[owner] = item
    return sorted(best.values(), key=lambda item: item.score, reverse=True)[:limit]


def dedupe(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


# ── 보여주기 ─────────────────────────────────────────────────────────────────


def is_past(status: str) -> bool:
    return status in PAST_STATUSES


def status_label(status: str, superseded_by: str = "") -> str:
    if status == "draft":
        return "draft · 승인 전 초안"
    if status == "active":
        return "active · 진행 중인 합의"
    if status == "fulfilled":
        return "지난 기록 · fulfilled (끝난 합의)"
    if status == "abandoned":
        return "지난 기록 · abandoned (접은 합의)"
    if status == "superseded":
        target = f" → {superseded_by}" if superseded_by else ""
        return f"지난 기록 · superseded (대체됨{target})"
    return "상태 불명"


def _excerpt(content: str, hits: list[str]) -> str:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if not lines:
        return ""
    best = max(lines, key=lambda line: sum(token in line.lower() for token in hits)) if hits else lines[0]
    best = re.sub(r"^[-*]\s+", "", best)
    return best if len(best) <= EXCERPT_CHARS else best[:EXCERPT_CHARS].rstrip() + "…"


def _display_path(path: str, cwd: Path | None) -> str:
    if cwd is not None:
        try:
            return str(Path(path).relative_to(cwd))
        except ValueError:
            pass
    return path


def format_block(found: list[Candidate], cwd: Path | None = None) -> str:
    """기억 출력 뒤에 붙는 블록. 어떤 줄도 `[` 로 시작하지 않는다 — `[경로]` 줄은 기억 결과의 계약이다."""
    if not found:
        return ""
    parts = [f"{BLOCK_HEADER}\n{BLOCK_NOTE}"]
    for item in found:
        fields = item.fields
        updated = fields.get("updated", "")[:10] or "날짜 없음"
        head = (
            f"intent {fields.get('intent_id', '?')} · {status_label(fields.get('status', ''), fields.get('superseded_by', ''))}"
            f" · rev {fields.get('revision', '?')} · {updated} 갱신"
        )
        section = fields.get("section", "")
        excerpt = _excerpt(fields.get("content", ""), item.hits)
        body = [f"  {fields.get('title', '')}"]
        if excerpt:
            prefix = f"{section}: " if section else ""
            body.append(f"  {prefix}{excerpt}")
        body.append(f"  {_display_path(fields.get('path', ''), cwd)}")
        parts.append("\n".join([head, *body]))
    return "\n\n".join(parts)


def render(memory_output: str, found: list[Candidate], cwd: Path | None = None) -> str:
    """기억 출력이 먼저, intent 블록은 그 뒤에 따로."""
    block = format_block(found, cwd)
    return f"{memory_output}\n\n{block}" if block else memory_output
