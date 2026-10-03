"""합의 기록(intent) 검색. `python3 -m unittest test_msearch_intent` (표준 라이브러리만).

Redis 와 임베딩은 가짜로 바꾼다. 랭킹 문턱이 실제 질의에 맞는지는 README 의 표본 출력과
`reference/memory-benchmark.sh` 가 따로 본다.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import msearch_config as config
import msearch_freshness
import msearch_intent as intent


def record(intent_id: str, status: str, body: str, revision: int = 1, superseded_by: str | None = None) -> str:
    closed = status in ("fulfilled", "abandoned", "superseded")
    meta = {
        "schema": 1,
        "id": intent_id,
        "status": status,
        "revision": revision,
        "source": "user request",
        "revision_source": None,
        "created": "2026-09-20T00:00:00.000Z",
        "updated": "2026-10-03T16:04:44.615Z",
        "approval": None if status == "draft" else "user ok",
        "approved_sha256": None,
        "closure_evidence": "commit abc" if closed else None,
        "superseded_by": superseded_by,
    }
    head = "\n".join(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in meta.items())
    return f"---\n{head}\n---\n\n{body}"


CACHE_BODY = """# Intent: Rubato 엔진을 stock pi 0.86.1로 올린다

## Problem

핀이 0.85.1에 멈춰 있고 업스트림은 0.86.1이다. 패치 전체가 무효가 된다.

## Constraints

- **Rubato는 98~99% 프롬프트 캐시 히트를 지향한다.** 캐시 가능한 프리픽스를 턴마다 흔드는 변경은 하지 않는다.
- [링크로 시작하는 줄](https://example.invalid) 도 블록 안에서는 들여쓴다. 출처: 사용자.

## Open questions

0.86.0 의 Breaking Changes 중 우리 feature 가 실제로 의존하는 것은 조사하면서 판정한다.
"""


class FakePipeline:
    def __init__(self, redis: "FakeRedis") -> None:
        self.redis = redis
        self.ops: list[tuple] = []

    def hset(self, key, mapping):
        self.ops.append(("hset", key, mapping))

    def set(self, key, value):
        self.ops.append(("set", key, value))

    def sadd(self, key, value):
        self.ops.append(("sadd", key, value))

    def execute(self):
        for op, key, value in self.ops:
            getattr(self.redis, op)(key, value) if op != "hset" else self.redis.hset(key, mapping=value)
        self.ops.clear()


class FakeRedis:
    """intent 색인과 신선도 검사가 쓰는 만큼만 흉내 낸다."""

    def __init__(self) -> None:
        self.kv: dict[str, object] = {}
        self.sets: dict[str, set[str]] = {}
        self.indexes: set[str] = set()

    def execute_command(self, *args):
        if args[0] == "FT.INFO":
            if args[1] not in self.indexes:
                raise RuntimeError("Unknown index name")
            return []
        if args[0] == "FT.CREATE":
            self.indexes.add(args[1])
            return "OK"
        raise AssertionError(f"unexpected command {args[0]}")

    def get(self, key):
        value = self.kv.get(key)
        return value.encode() if isinstance(value, str) else value

    def mget(self, keys):
        return [self.get(key) for key in keys]

    def set(self, key, value):
        self.kv[key] = value

    def hset(self, key, mapping):
        self.kv.setdefault(key, {}).update(mapping)

    def delete(self, *keys):
        for key in keys:
            self.kv.pop(key, None)
            self.sets.pop(key, None)

    def scan_iter(self, match, count=0):
        pattern = re.compile(re.escape(match).replace(r"\*", ".*") + "$")
        return [key for key in list(self.kv) if pattern.match(key)]

    def smembers(self, key):
        return {item.encode() for item in self.sets.get(key, set())}

    def sadd(self, key, value):
        self.sets.setdefault(key, set()).add(value)

    def srem(self, key, value):
        self.sets.get(key, set()).discard(value)

    def pipeline(self, transaction=False):
        return FakePipeline(self)


class Workspace(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="msearch-intent-")
        self.root = Path(os.path.realpath(self._tmp.name))
        self.agents = self.root / "memory" / "agents"
        self.project = self.root / "work" / "rubato-lab"
        self.other = self.root / "work" / "other"
        self.store("rubato", [self.project, self.project / "rubato"])
        self.store("other", [self.other])

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def store(self, name: str, roots: list[Path]) -> None:
        (self.agents / name).mkdir(parents=True, exist_ok=True)
        (self.agents / name / "store.json").write_text(json.dumps({"roots": [str(root) for root in roots]}))

    def write(self, root: Path, intent_id: str, text: str) -> Path:
        path = root / "intent" / intent_id / "intent.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path


class DiscoveryTest(Workspace):
    def test_store_roots_find_intents_of_that_store_only(self) -> None:
        mine = self.write(self.project, "stock-pi-0-86-1", record("stock-pi-0-86-1", "fulfilled", CACHE_BODY))
        theirs = self.write(self.other, "elsewhere", record("elsewhere", "active", CACHE_BODY))
        self.assertEqual(intent.discover(intent.store_roots(self.agents, "rubato")), [mine])
        self.assertEqual(sorted(intent.corpus(self.agents)), sorted([mine, theirs]))

    def test_hidden_directories_and_symlinks_are_not_intents(self) -> None:
        self.write(self.project, ".draft", record("draft", "draft", CACHE_BODY))
        real = self.write(self.other, "real", record("real", "active", CACHE_BODY))
        (self.project / "intent" / "linked").symlink_to(real.parent)
        self.assertEqual(intent.discover([self.project]), [])

    def test_store_without_roots_has_no_intents(self) -> None:
        self.assertEqual(intent.store_roots(self.agents, "missing"), [])


class RecordTest(Workspace):
    def test_frontmatter_fields_reach_every_chunk(self) -> None:
        path = self.write(self.project, "old", record("old", "superseded", CACHE_BODY, revision=3, superseded_by="new"))
        chunks = intent.chunk(path)
        self.assertEqual([item.section for item in chunks], ["Problem", "Constraints", "Open questions"])
        for item in chunks:
            self.assertEqual(item.meta.intent_id, "old")
            self.assertEqual(item.meta.status, "superseded")
            self.assertEqual(item.meta.revision, "3")
            self.assertEqual(item.meta.superseded_by, "new")
            self.assertEqual(item.meta.title, "Rubato 엔진을 stock pi 0.86.1로 올린다")
            # 기억 인덱스의 프리픽스 밖에 산다 — 기억 랭킹·정리 로직이 intent 를 볼 수 없다.
            self.assertTrue(item.key.startswith(config.INTENT_KEY_PREFIX))
            self.assertFalse(item.key.startswith(config.KEY_PREFIX))

    def test_unknown_status_is_not_promoted(self) -> None:
        meta, _ = intent.read_meta(record("x", "weird", CACHE_BODY), Path("/p/intent/x/intent.md"))
        self.assertEqual(meta.status, "unknown")


def candidate(path: str, status: str, content: str, distance: float | None, section: str = "Constraints") -> intent.Candidate:
    return intent.Candidate(
        fields={
            "path": path,
            "intent_id": Path(path).parent.name,
            "status": status,
            "revision": "1",
            "updated": "2026-10-03T16:04:44.615Z",
            "superseded_by": "",
            "title": Path(path).parent.name,
            "section": section,
            "content": content,
        },
        distance=distance,
    )


class SelectTest(unittest.TestCase):
    def corpus(self, cache_distance: float, noise_distance: float) -> list[intent.Candidate]:
        filler = [
            candidate(f"/p/intent/f{index}/intent.md", "active", "모델 작업 기록을 정리한다.", 0.9)
            for index in range(6)
        ]
        return [
            candidate("/p/intent/cache/intent.md", "fulfilled", "Rubato는 98~99% 프롬프트 캐시 히트를 지향한다.", cache_distance),
            candidate("/p/intent/cache/intent.md", "fulfilled", "핀을 올린다.", 0.95, section="Problem"),
            candidate("/p/intent/noise/intent.md", "active", "모델 작업 순서를 바꾼다.", noise_distance),
            *filler,
        ]

    def test_rare_words_close_in_meaning_win_one_slot_per_intent(self) -> None:
        found = intent.select(self.corpus(0.72, 0.6), ["프롬프트", "캐시", "히트", "목표"])
        self.assertEqual([item.fields["intent_id"] for item in found], ["cache"])
        self.assertEqual(found[0].fields["section"], "Constraints")

    def test_common_words_are_not_evidence(self) -> None:
        self.assertEqual(intent.select(self.corpus(0.9, 0.6), ["모델", "작업"]), [])

    def test_a_rare_predicate_is_not_a_topic(self) -> None:
        items = self.corpus(0.9, 0.62)
        items[2].fields["content"] = "모델 목록을 모든 표면이 같이 읽는다."
        self.assertEqual(intent.select(items, ["모델", "이미지", "읽는다"]), [])

    def test_lexical_match_far_in_meaning_is_dropped(self) -> None:
        self.assertEqual(intent.select(self.corpus(0.8, 0.9), ["프롬프트", "캐시", "히트"]), [])

    def test_very_close_meaning_alone_is_enough(self) -> None:
        found = intent.select(self.corpus(0.4, 0.9), ["prompt", "cache"])
        self.assertEqual([item.fields["intent_id"] for item in found], ["cache"])

    def test_latin_tokens_match_whole_words(self) -> None:
        items = [candidate("/p/intent/a/intent.md", "active", "the api pipeline", 0.7)]
        self.assertEqual(intent.select(items, ["pi"]), [])


class RenderTest(unittest.TestCase):
    def found(self, status: str, superseded_by: str = "") -> list[intent.Candidate]:
        item = candidate("/w/intent/stock-pi-0-86-1/intent.md", status, CACHE_BODY.split("## Constraints")[1], 0.7)
        item.fields["superseded_by"] = superseded_by
        item.fields["revision"] = "2"
        item.hits = ["캐시"]
        return [item]

    def test_block_follows_memory_and_never_looks_like_a_memory_result(self) -> None:
        memory = "**prompt-cache**\n[rubato/repo/reference/project/prompt-cache-prefix.md]\n본문"
        out = intent.render(memory, self.found("fulfilled"), cwd=Path("/w"))
        self.assertTrue(out.startswith(memory))
        block = out[len(memory):]
        # 벤치마크는 `^[경로]` 줄을 기억 결과로 센다. intent 블록에는 그런 줄이 없어야 한다.
        self.assertEqual(re.findall(r"^\[", block, re.M), [])
        self.assertEqual(re.findall(r"^\[[^]]*\]", out, re.M), ["[rubato/repo/reference/project/prompt-cache-prefix.md]"])
        self.assertIn(intent.BLOCK_HEADER, block)
        self.assertIn("intent stock-pi-0-86-1", block)
        self.assertIn("rev 2", block)
        self.assertIn("2026-10-03", block)
        self.assertIn("intent/stock-pi-0-86-1/intent.md", block)
        self.assertIn("98~99% 프롬프트 캐시 히트", block)

    def test_closed_records_are_marked_past_and_open_ones_are_not(self) -> None:
        for status in ("fulfilled", "abandoned", "superseded"):
            self.assertTrue(intent.is_past(status))
            self.assertIn("지난 기록", intent.format_block(self.found(status)))
        self.assertIn("→ next-id", intent.format_block(self.found("superseded", "next-id")))
        for status in ("draft", "active"):
            self.assertFalse(intent.is_past(status))
            block = intent.format_block(self.found(status))
            self.assertNotIn("지난 기록 ·", block)
            self.assertIn(status, block)

    def test_nothing_found_leaves_memory_output_untouched(self) -> None:
        self.assertEqual(intent.render("NO RELEVANT MEMORY", []), "NO RELEVANT MEMORY")


class IndexAndFreshnessTest(Workspace):
    def setUp(self) -> None:
        super().setUp()
        self.redis = FakeRedis()
        self.embedded: list[str] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.embedded.extend(texts)
        return [[0.0] * 4 for _ in texts]

    def index(self, incremental: bool = True):
        return intent.index(self.redis, self.embed, lambda text: text, incremental, self.agents, log=lambda _: None)

    def test_changed_added_and_removed_intents_are_seen_and_caught_up(self) -> None:
        first = self.write(self.project, "a", record("a", "active", CACHE_BODY))
        self.assertTrue(intent.is_stale(self.redis, self.agents))
        self.assertEqual(self.index(), (1, []))
        self.assertIn(config.INTENT_INDEX_NAME, self.redis.indexes)
        self.assertFalse(intent.is_stale(self.redis, self.agents))

        # 바뀐 파일만 다시 임베딩한다.
        second = self.write(self.other, "b", record("b", "draft", CACHE_BODY))
        self.assertTrue(intent.is_stale(self.redis, self.agents))
        self.embedded.clear()
        self.assertEqual(self.index(), (1, []))
        self.assertTrue(all("stock pi" in text for text in self.embedded))
        self.assertEqual(len(self.embedded), len(intent.chunk(second)))

        first.write_text(record("a", "fulfilled", CACHE_BODY), encoding="utf-8")
        self.assertTrue(intent.is_stale(self.redis, self.agents))
        self.index()
        statuses = {value["status"] for key, value in self.redis.kv.items() if isinstance(value, dict) and value["path"] == str(first)}
        self.assertEqual(statuses, {"fulfilled"})

        # 지운 기록은 색인에서도 사라져야 한다. 안 그러면 없는 합의가 계속 뜬다.
        second.unlink()
        self.assertTrue(intent.is_stale(self.redis, self.agents))
        self.index()
        self.assertFalse(intent.is_stale(self.redis, self.agents))
        self.assertFalse([key for key, value in self.redis.kv.items() if isinstance(value, dict) and value["path"] == str(second)])

    def test_full_reindex_rebuilds_everything(self) -> None:
        self.write(self.project, "a", record("a", "active", CACHE_BODY))
        self.index()
        self.embedded.clear()
        self.assertEqual(self.index(incremental=False), (1, []))
        self.assertTrue(self.embedded)

    def test_search_freshness_check_covers_intents(self) -> None:
        path = self.write(self.project, "a", record("a", "active", CACHE_BODY))
        with mock.patch.object(config, "MEMORY_ROOT", self.agents):
            self.assertTrue(msearch_freshness.is_stale(self.redis))
            self.index()
            self.assertFalse(msearch_freshness.is_stale(self.redis))
            path.write_text(record("a", "fulfilled", CACHE_BODY), encoding="utf-8")
            self.assertTrue(msearch_freshness.is_stale(self.redis))


if __name__ == "__main__":
    unittest.main()
