"""A symptom hit answers with the file's conclusion. `python3 -m unittest test_msearch_symptom`.

Records are written in English; stores not yet migrated keep the Korean headings. Both must answer.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_search():
    spec = importlib.util.spec_from_file_location("memory_search", HERE / "memory-search.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["memory_search"] = module  # dataclasses look their module up here
    spec.loader.exec_module(module)
    return module


try:
    search = load_search()
except ImportError as error:  # redis/dotenv missing: the runtime check installs them
    search = None
    IMPORT_ERROR = str(error)


@unittest.skipIf(search is None, "memory-search dependencies are not installed")
class SymptomHitTest(unittest.TestCase):
    def answer(self, text: str, section: str) -> dict[str, object]:
        with tempfile.TemporaryDirectory() as root:
            Path(root, "decisions").mkdir()
            Path(root, "decisions", "x.md").write_text(text, encoding="utf-8")
            original = search.MEMORY_ROOT
            search.MEMORY_ROOT = Path(root)
            try:
                return search.answer_symptom_hits([{"rel_path": "decisions/x.md", "section": section, "content": "raw"}])[0]
            finally:
                search.MEMORY_ROOT = original

    def test_english_symptom_hit_returns_the_conclusion(self) -> None:
        hit = self.answer("## Conclusion\n- keep the prefix stable\n\n## Symptom\n캐시가 깨진다\n", "Symptom")
        self.assertEqual(hit["content"], "- keep the prefix stable")
        self.assertEqual(hit["section"], "Conclusion (found by symptom)")

    def test_unmigrated_korean_headings_still_answer(self) -> None:
        hit = self.answer("## 결론\n- 접두는 고정\n\n## 증상\n캐시가 깨진다\n", "증상")
        self.assertEqual(hit["content"], "- 접두는 고정")

    def test_other_sections_pass_through(self) -> None:
        hit = self.answer("## Conclusion\n- a\n", "Rationale")
        self.assertEqual(hit["content"], "raw")


if __name__ == "__main__":
    unittest.main()
