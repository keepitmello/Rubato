"""A Korean query also runs as English. `python3 -m unittest test_msearch_translate` (no network)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent


def load_search():
    spec = importlib.util.spec_from_file_location("memory_search_translate", HERE / "memory-search.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["memory_search_translate"] = module
    spec.loader.exec_module(module)
    return module


try:
    search = load_search()
except ImportError:
    search = None


@unittest.skipIf(search is None, "memory-search dependencies are not installed")
class EnglishQueryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.cache = Path(self.dir.name, "query-translations.json")
        self.patches = [mock.patch.object(search, "TRANSLATION_CACHE_PATH", self.cache), mock.patch.dict(os.environ, {"MSEARCH_TRANSLATE": "1"})]
        for patch in self.patches:
            patch.start()
        search.english_query.cache_clear()

    def tearDown(self) -> None:
        for patch in self.patches:
            patch.stop()
        search.english_query.cache_clear()
        self.dir.cleanup()

    def test_english_query_is_not_translated(self) -> None:
        with mock.patch.object(search, "_translate", side_effect=AssertionError("no call")):
            self.assertIsNone(search.english_query("prompt cache prefix"))

    def test_korean_query_is_translated_once_and_cached(self) -> None:
        with mock.patch.object(search, "_translate", return_value="prompt cache hit target") as call:
            self.assertEqual(search.english_query("프롬프트 캐시 히트 목표"), "prompt cache hit target")
            search.english_query.cache_clear()
            self.assertEqual(search.english_query("프롬프트 캐시 히트 목표"), "prompt cache hit target")
        self.assertEqual(call.call_count, 1)
        self.assertEqual(json.loads(self.cache.read_text(encoding="utf-8"))["entries"], {"프롬프트 캐시 히트 목표": "prompt cache hit target"})

    def test_a_cache_from_another_model_or_prompt_is_not_reused(self) -> None:
        self.cache.write_text(json.dumps({"version": "old", "entries": {"사고 설정": "accident settings"}}), encoding="utf-8")
        with mock.patch.object(search, "_translate", return_value="thinking settings") as call:
            self.assertEqual(search.english_query("사고 설정"), "thinking settings")
        self.assertEqual(call.call_count, 1)

    def test_failure_or_switch_off_means_the_original_alone(self) -> None:
        with mock.patch.object(search, "_translate", side_effect=RuntimeError("offline")):
            self.assertIsNone(search.english_query("캐시 98% 조건"))
        with mock.patch.dict(os.environ, {"MSEARCH_TRANSLATE": "0"}), mock.patch.object(search, "_translate", side_effect=AssertionError("no call")):
            search.english_query.cache_clear()
            self.assertIsNone(search.english_query("캐시 98% 조건 꺼짐"))

    def test_merge_keeps_each_file_section_once_with_its_best_score(self) -> None:
        merged = search.merge_ranked(
            [{"rel_path": "a.md", "section": "Symptom", "rank_score": 15.0}, {"rel_path": "b.md", "section": "", "rank_score": 9.0}],
            [{"rel_path": "b.md", "section": "", "rank_score": 12.0}, {"rel_path": "c.md", "section": "", "rank_score": 3.0}],
        )
        self.assertEqual([(m["rel_path"], m["rank_score"]) for m in merged], [("a.md", 15.0), ("b.md", 12.0), ("c.md", 3.0)])


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(search is None, "memory-search dependencies are not installed")
class EnglishTokensTest(unittest.TestCase):
    def test_english_function_words_are_not_evidence(self) -> None:
        tokens = search.bm25_tokens("Postgres index is not used and a sequential scan is performed", [])
        self.assertNotIn("is", tokens)
        self.assertNotIn("not", tokens)
        self.assertNotIn("and", tokens)
        self.assertIn("postgres", tokens)
        self.assertIn("sequential", tokens)

    def test_a_phrase_of_function_words_is_not_a_core_phrase(self) -> None:
        self.assertFalse(search.core_phrase_hit("Postgres index is not used", [], "this value is not used anywhere"))
