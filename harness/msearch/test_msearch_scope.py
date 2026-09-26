"""msearch_scope 의 저장소 규칙. `python3 -m unittest test_msearch_scope` (표준 라이브러리만)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from msearch_scope import resolve_store, sanitize_to_slug, short_hash


def git_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    return Path(os.path.realpath(path))


class ResolveStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="msearch-scope-")
        self.root = Path(os.path.realpath(self._tmp.name))
        self.agents = self.root / "memory" / "agents"
        self.home = self.root / "home"
        self.home.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def resolve(self, cwd: Path) -> str | None:
        return resolve_store(cwd, self.agents, self.home)

    def record(self, store: str, roots: list[str]) -> None:
        (self.agents / store).mkdir(parents=True, exist_ok=True)
        (self.agents / store / "store.json").write_text(json.dumps({"roots": roots}))

    def test_git_subfolder_resolves_to_the_root_store(self) -> None:
        repo = git_repo(self.root / "work" / "Hash-Game")
        (repo / "src" / "deep").mkdir(parents=True)
        self.assertEqual(self.resolve(repo / "src" / "deep"), "hash-game")
        self.assertFalse(self.agents.exists())

    def test_same_basename_repos_get_distinct_names(self) -> None:
        first = git_repo(self.root / "a" / "app")
        second = git_repo(self.root / "b" / "app")
        self.record("app", [str(first)])
        self.assertEqual(self.resolve(first), "app")
        self.assertEqual(self.resolve(second), f"app-{short_hash(str(second))}")

    def test_store_json_root_wins_over_the_basename(self) -> None:
        repo = git_repo(self.root / "renamed-checkout")
        self.record("shared", [str(repo)])
        self.assertEqual(self.resolve(repo), "shared")

    def test_home_resolves_to_home_and_a_folder_below_it_does_not(self) -> None:
        (self.home / "Downloads").mkdir()
        self.assertEqual(self.resolve(self.home), "home")
        self.assertIsNone(self.resolve(self.home / "Downloads"))

    def test_plain_folder_has_no_store(self) -> None:
        plain = self.root / "scratch"
        plain.mkdir()
        self.assertIsNone(self.resolve(plain))

    def test_config_name_wins_over_the_repository(self) -> None:
        repo = git_repo(self.root / "rubato-lab")
        (repo / ".rubato").mkdir()
        (repo / ".rubato" / "rubato.jsonc").write_text('{\n  // shared\n  "memory": { "agent": "rubato" }\n}\n')
        self.assertEqual(self.resolve(repo), "rubato")

    def test_slug_matches_the_engine_rule(self) -> None:
        self.assertEqual(sanitize_to_slug("élan"), "elan")
        self.assertEqual(sanitize_to_slug("漢字"), "agent")
        self.assertEqual(sanitize_to_slug(" -x- "), "x")


if __name__ == "__main__":
    unittest.main()
