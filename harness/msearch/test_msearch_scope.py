"""msearch_scope 의 저장소 규칙. `python3 -m unittest test_msearch_scope` (표준 라이브러리만)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from msearch_scope import USER_STORE, in_scopes, resolve_store, sanitize_to_slug, search_scopes, short_hash


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


class SearchScopesTest(unittest.TestCase):
    """기본 검색은 현재 프로젝트와 공용 사용자 기억이고, 다른 프로젝트는 묻지 않으면 안 섞인다."""

    hits = [
        "project-a/repo/decisions/why-a.md",
        "project-b/repo/decisions/why-b.md",
        f"{USER_STORE}/repo/preferences/answer-length.md",
    ]

    def kept(self, scopes: frozenset[str] | None) -> list[str]:
        return [hit for hit in self.hits if in_scopes(hit, scopes)]

    def test_default_is_the_current_project_plus_the_user(self) -> None:
        indexed = ["project-a", "project-b", USER_STORE]
        scopes, widened = search_scopes("project-a", indexed)
        self.assertFalse(widened)
        self.assertEqual(self.kept(scopes), [self.hits[0], self.hits[2]])
        scopes, _ = search_scopes("project-b", indexed)
        self.assertEqual(self.kept(scopes), [self.hits[1], self.hits[2]])

    def test_user_memory_is_found_even_before_the_project_has_any(self) -> None:
        scopes, widened = search_scopes("project-a", ["project-a", USER_STORE])
        self.assertIn(USER_STORE, scopes or set())
        self.assertFalse(widened)

    def test_user_flag_searches_only_the_user(self) -> None:
        scopes, widened = search_scopes(None, [], user_only=True)
        self.assertEqual(self.kept(scopes), [self.hits[2]])
        self.assertFalse(widened)

    def test_explicit_scope_and_all(self) -> None:
        self.assertEqual(self.kept(search_scopes(None, [], scope="project-b")[0]), [self.hits[1]])
        self.assertEqual(self.kept(search_scopes(None, [], everything=True)[0]), self.hits)

    def test_no_store_here_widens_and_says_so(self) -> None:
        scopes, widened = search_scopes(None, ["project-a", USER_STORE])
        self.assertIsNone(scopes)
        self.assertTrue(widened)

    def test_no_folder_resolves_to_the_user_store(self) -> None:
        with tempfile.TemporaryDirectory(prefix="msearch-scope-") as tmp:
            root = Path(os.path.realpath(tmp))
            repo = git_repo(root / "user.shared")
            self.assertNotEqual(resolve_store(repo, root / "agents", root), USER_STORE)
            config = root / "named" / ".rubato"
            config.mkdir(parents=True)
            (config / "rubato.jsonc").write_text('{"memory": {"agent": "user.shared"}}')
            self.assertNotEqual(resolve_store(root / "named", root / "agents", root), USER_STORE)
