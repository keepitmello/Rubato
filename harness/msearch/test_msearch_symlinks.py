"""A folder linked into the memory root is indexed (Segno links repository docs into memory/ref/)."""
from __future__ import annotations

import importlib.util
import signal
import sys
import tempfile
import unittest
from unittest import mock
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


class WalkDidNotEnd(Exception):
    """Not an OSError: the walk swallows those."""


def stuck(*_):
    raise WalkDidNotEnd("the walk did not end within 10 s")


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

    def test_two_loops_in_one_folder_end_and_find_each_file_once(self):
        # pathlib's rglob(recurse_symlinks=True) branched at every level here and did not end.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp, "memory")
            (root / "a").mkdir(parents=True)
            (root / "a" / "n.md").write_text("# n\n")
            (root / "a" / "up").symlink_to("..", target_is_directory=True)
            (root / "a" / "self").symlink_to("../a", target_is_directory=True)
            signal.signal(signal.SIGALRM, stuck)
            signal.alarm(10)
            try:
                found = self.discover(root)
            finally:
                signal.alarm(0)
            self.assertEqual(found, [(root / "a" / "n.md").resolve()])

    def test_a_store_without_links_indexes_the_same_files_as_before(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve() / "memory"  # store-relative names, as a real store under its own root
            for rel in ("MEMORY.md", "decisions/a.md", "decisions/deep/b.md", ".hidden/c.md", "notes.txt",
                        "x.md.bak", "repo/.git/d.md", "runtime/e.md", "backups/f.md", "Upper.MD"):
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_text("# x\n")
            (root / "dir.md").mkdir()
            # The walk before linked folders were followed: rglob without recurse_symlinks.
            saved = index.PROJECT_ROOT
            index.PROJECT_ROOT = root
            try:
                before = sorted({index.rel_path(p) for p in root.rglob("*.md") if p.is_file() and not index.is_excluded(p)})
                after = [index.rel_path(p) for p in index.discover_markdown_files()]
            finally:
                index.PROJECT_ROOT = saved
            self.assertEqual(after, before)
            self.assertEqual(after, sorted([".hidden/c.md", "MEMORY.md", "decisions/a.md", "decisions/deep/b.md"]))

    def test_a_linked_file_outside_the_root_never_shares_a_name_with_one_inside(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve() / "home"
            root = home / "memory"
            (root / "work").mkdir(parents=True)
            (root / "work" / "context.md").write_text("# inside\n")
            (home / "work").mkdir()
            (home / "work" / "context.md").write_text("# outside\n")
            (root / "ref").mkdir()
            (root / "ref" / "work").symlink_to(home / "work", target_is_directory=True)
            saved = index.PROJECT_ROOT
            index.PROJECT_ROOT = root
            try:
                with mock.patch("pathlib.Path.home", return_value=home):
                    found = index.discover_markdown_files()
                    names = sorted(index.rel_path(path) for path in found)
                    ids = {index.file_id(path) for path in found}
                    rebuilt = {index.file_id(root / name) for name in names}
            finally:
                index.PROJECT_ROOT = saved
            self.assertEqual(names, ["work/context.md", "~/work/context.md"])
            self.assertEqual(len(ids), 2)
            self.assertEqual(rebuilt, ids, "cleanup rebuilds a stored name into the same file id")

    def discover(self, root):
        saved = index.PROJECT_ROOT
        index.PROJECT_ROOT = root
        try:
            return sorted(path.resolve() for path in index.discover_markdown_files())
        finally:
            index.PROJECT_ROOT = saved


if __name__ == "__main__":
    unittest.main()
