"""A folder linked into the memory root is indexed (Segno links repository docs into memory/ref/)."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_index():
    spec = importlib.util.spec_from_file_location("memory_index", HERE / "memory-index.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["memory_index"] = module
    spec.loader.exec_module(module)
    return module


try:
    index = load_index()
except ImportError as error:  # redis/dotenv/konlpy missing: the runtime check installs them
    index = None
    IMPORT_ERROR = str(error)


@unittest.skipIf(index is None, "memory-index dependencies are not installed")
class LinkedFolders(unittest.TestCase):
    def test_a_linked_folder_is_indexed_once_even_through_a_loop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp, "memory")
            (root / "ref").mkdir(parents=True)
            (root / "own.md").write_text("# mine\n")
            docs = Path(tmp, "repo", "docs", "companies")
            docs.mkdir(parents=True)
            (docs / "acme.md").write_text("# acme\n")
            (root / "ref" / "companies").symlink_to(docs, target_is_directory=True)
            (docs / "back").symlink_to(root, target_is_directory=True)  # a loop back into the root
            saved = index.PROJECT_ROOT
            index.PROJECT_ROOT = root
            try:
                found = [path.resolve() for path in index.discover_markdown_files()]
            finally:
                index.PROJECT_ROOT = saved
            self.assertEqual(sorted(found), sorted({(root / "own.md").resolve(), (docs / "acme.md").resolve()}))


if __name__ == "__main__":
    unittest.main()
