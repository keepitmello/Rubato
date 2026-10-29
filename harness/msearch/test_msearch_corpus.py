"""A private existing repository keeps its selected records searchable, without duplicate files."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import msearch_config as config


class ExistingHomeCorpus(unittest.TestCase):
    def test_original_sources_include_resident_docs_archives_and_game_docs_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            included = [
                "memory/2026-01-01.md", "memory/archive/2025.md",
                "memory/legacy/original.md", "memory/diary/2026-01-01.md",
                "USER.md", "SOUL.md", "MEMORY.md", "COMPANION.md", "TOOLS.md",
                "IDENTITY.md", "docs/txgame/current.md",
            ]
            omitted = ["memory/diary/raw/private.md", "memory/backups/copy.md",
                       "notes/permanent.md", "docs/other.md", "system.md"]
            for rel in included + omitted:
                file = root / rel
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(rel)
            sources = ["memory", "docs/txgame", "USER.md", "SOUL.md", "MEMORY.md",
                       "COMPANION.md", "TOOLS.md", "IDENTITY.md"]
            with patch.object(config, "CORPUS_PATHS", sources), \
                    patch.object(config, "EXCLUDE_PATH_FRAGMENTS",
                                 (*config.EXCLUDE_PATH_FRAGMENTS, "diary/raw/")):
                found = {file.relative_to(root).as_posix() for file in config.corpus_files(root)}
                self.assertEqual(found, set(included))
                new = root / "memory/new.md"
                new.write_text("new record")
                self.assertIn(new, config.corpus_files(root))
                new.unlink()
                self.assertNotIn(new, config.corpus_files(root))
            self.assertEqual((root / "notes/permanent.md").read_text(), "notes/permanent.md")

    def test_linked_folders_are_freshness_inputs_once_even_through_a_loop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "memory"
            docs = Path(tmp) / "docs"
            root.mkdir()
            docs.mkdir()
            file = docs / "record.md"
            file.write_text("current record")
            (root / "ref").symlink_to(docs, target_is_directory=True)
            (docs / "loop").symlink_to(root, target_is_directory=True)
            with patch.object(config, "CORPUS_PATHS", None):
                self.assertEqual([path.resolve() for path in config.corpus_files(root)], [file.resolve()])


if __name__ == "__main__":
    unittest.main()
