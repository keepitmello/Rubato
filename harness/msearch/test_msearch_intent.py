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
        #: FT.SEARCH 가 돌려줄 거리. 조각 필드를 받아 거리를 준다. 실제 임베딩 대신이다.
        self.distance = lambda fields: 0.95
        self.hide_items = False

    def ft_search(self, args):
        names = list(args[args.index("RETURN") + 2:args.index("RETURN") + 2 + int(args[args.index("RETURN") + 1])])
        docs = [
            (key, value)
            for key, value in self.kv.items()
            if isinstance(value, dict) and key.startswith(config.INTENT_KEY_PREFIX)
            and not (self.hide_items and value.get("part") == "item")
        ]
        reply: list[object] = [len(docs)]
        for key, fields in docs:
            flat: list[bytes] = []
            for name in names:
                value = self.distance(fields) if name == "distance" else fields.get(name, "")
                flat += [name.encode(), str(value).encode()]
            reply += [key.encode(), flat]
        return reply

    def execute_command(self, *args):
        if args[0] == "FT.SEARCH":
            return self.ft_search(args)
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
        self.assertEqual(
            [(item.section, item.part) for item in chunks],
            [("Problem", ""), ("Constraints", ""), ("Constraints", "item"), ("Constraints", "item"), ("Open questions", "")],
        )
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


STOCK_PI_BODY = """# Intent: Rubato 엔진을 stock pi 0.86.1로 올린다

## Problem

핀이 0.85.1에 멈춰 있고 업스트림은 0.86.1이다. 패치 전체가 무효가 된다.

## Constraints

- **Rubato의 엔진은 pi다. senpi를 실행 경로에 되살리지 않는다.** 출처: 사용자, 2026-09-20.
- pi를 먼저 올리고 senpi는 그다음에 본다. 출처: 사용자, 2026-09-20.
- live 설치 `~/.rubato-pi/stock-engine`은 staged 복사본이다. 레포 편집이 도는 세션을 흔들지 않고, 재-stage는 의도적으로만 한다.
- 0.86.0의 Breaking Changes 셋은 자동 수용 대상이 아니라 판정 대상이다.
- **Rubato는 98~99% 프롬프트 캐시 히트를 지향한다.** 캐시 가능한 프리픽스(시스템 프롬프트, 툴 스키마, 초기 메시지)를 턴마다 흔드는 변경은 하지 않는다. 창마다 바뀌는 값을 프리픽스에 넣는 설계는 기각한다. 출처: 사용자, 2026-09-21.

## Open questions

0.86.0 의 Breaking Changes 중 우리 feature 가 실제로 의존하는 것은 조사하면서 판정한다.
"""


class ItemTest(unittest.TestCase):
    def test_top_level_items_keep_their_continuation_lines(self) -> None:
        content = "앞 문단은 어느 항목에도 붙지 않는다.\n- 첫 항목은 충분히 길게 적은 조건이다\n  이어지는 줄도 같은 항목이다\n\n- 둘째 항목도 충분히 길게 적은 조건이다\n뒤 문단은 붙지 않는다."
        self.assertEqual(
            intent._items(content),
            ["- 첫 항목은 충분히 길게 적은 조건이다 이어지는 줄도 같은 항목이다", "- 둘째 항목도 충분히 길게 적은 조건이다"],
        )

    def test_a_single_item_or_plain_prose_adds_nothing(self) -> None:
        self.assertEqual(intent._items("- 하나뿐인 항목은 절 조각과 같은 말이다."), [])
        self.assertEqual(intent._items("목록이 없는 문단이다. 문장이 둘이다."), [])

    def test_long_items_split_into_sentences_including_bold_ones(self) -> None:
        items = intent._items(STOCK_PI_BODY.split("## Constraints")[1].split("## Open")[0])
        self.assertIn("- **Rubato는 98~99% 프롬프트 캐시 히트를 지향한다.**", items)
        self.assertIn("캐시 가능한 프리픽스(시스템 프롬프트, 툴 스키마, 초기 메시지)를 턴마다 흔드는 변경은 하지 않는다.", items)
        self.assertIn("- pi를 먼저 올리고 senpi는 그다음에 본다. 출처: 사용자, 2026-09-20.", items)


# 다른 기록들. 질의 단어가 범위 안에서 드문 단어로 남도록 그 단어들을 뺐다 (실제 코퍼스에서도 드물다).
FILLER_BODY = (
    CACHE_BODY.replace("캐시", "목록").replace("프리픽스", "순서").replace("지향", "선호").replace("히트", "결과")
)


class DilutedSectionTest(Workspace):
    """절 하나를 통째로 재면 조건 여럿이 섞여 멀어진다. 항목 조각이 그 거리를 좁힌다.

    거리는 실제 색인에서 잰 값이다(2026-10, text-embedding-3-small): 절 통째 vs 가장 가까운 항목.
    """

    CASES = (
        # 질의 토큰, 절 거리, 가까운 항목을 고르는 표지, 항목 거리
        (["캐시", "98"], 0.773, "98~99%", 0.676),
        (["캐시", "히트율", "지향", "조건"], 0.752, "98~99%", 0.599),
        (["프리픽스", "흔들지"], 0.804, "캐시 가능한 프리픽스", 0.694),
    )

    def setUp(self) -> None:
        super().setUp()
        self.redis = FakeRedis()
        self.write(self.project, "stock-pi-0-86-1", record("stock-pi-0-86-1", "fulfilled", STOCK_PI_BODY))
        for index in range(5):
            self.write(self.project, f"other-{index}", record(f"other-{index}", "active", FILLER_BODY))
        intent.index(self.redis, lambda texts: [[0.0] for _ in texts], lambda text: text, False, self.agents, log=lambda _: None)

    def search(self, tokens: list[str], section: float, marker: str, item: float) -> list[intent.Candidate]:
        def distance(fields: dict) -> float:
            if fields["intent_id"] != "stock-pi-0-86-1" or fields["section"] != "Constraints":
                return 0.95
            if fields.get("part") == "item":
                return item if marker in fields["content"] else 0.85
            return section
        self.redis.distance = distance
        return intent.search(self.redis, tokens, lambda: b"vec", None)

    def test_focused_items_recover_constraints_the_whole_section_missed(self) -> None:
        for tokens, section, marker, item in self.CASES:
            with self.subTest(tokens=tokens):
                found = self.search(tokens, section, marker, item)
                self.assertEqual([(c.fields["intent_id"], c.fields["section"]) for c in found], [("stock-pi-0-86-1", "Constraints")])
                self.assertAlmostEqual(found[0].distance, item)
                self.assertNotEqual(found[0].fields.get("part"), "item")

    def test_excerpt_shows_the_constraint_that_matched(self) -> None:
        # "프리픽스" 와 "흔들지" 는 다른 줄에 하나씩 걸린다. 동점이면 가장 가까운 항목의 줄이다.
        block = intent.format_block(self.search(*self.CASES[2]))
        self.assertIn("Constraints: **Rubato는 98~99% 프롬프트 캐시 히트를 지향한다.**", block)
        self.assertNotIn("live 설치", block)

    def test_without_items_the_same_queries_miss(self) -> None:
        self.redis.hide_items = True
        for tokens, section, marker, item in self.CASES:
            with self.subTest(tokens=tokens):
                self.assertEqual(self.search(tokens, section, marker, item), [])

    def test_excerpt_falls_back_to_the_nearest_item_when_no_word_matched(self) -> None:
        def distance(fields: dict) -> float:
            if fields.get("part") == "item" and "Breaking Changes 셋" in fields["content"]:
                return 0.3
            return 0.95
        self.redis.distance = distance
        found = intent.search(self.redis, ["upstream", "breaking"], lambda: b"vec", None)
        self.assertEqual(found[0].fields["intent_id"], "stock-pi-0-86-1")
        self.assertIn("Breaking Changes 셋은 자동 수용 대상이 아니라", intent.format_block(found))


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
