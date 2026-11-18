"""redis-service.sh finds the libraries the installed server and modules actually link.

The redis/redis tap moves on: its current cask stops listing a library (llvm@18) that the
installed 8.4.0 Search module still links. When brew cleanup removes it, Redis aborts at
module load and launchd restarts it forever (2026-11-16 → 11-18 on this machine).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "redis-service.sh"


def lock(key: str) -> str:
    for line in (HERE / "runtime.lock").read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    raise KeyError(key)


def executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)


@unittest.skipUnless(os.uname().sysname == "Darwin", "redis-service.sh only runs on macOS")
class RedisServicePlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.prefix = root / "brew"
        self.home = root / "home"
        self.home.mkdir()
        cask = self.prefix / "Caskroom/redis" / lock("REDIS_VERSION")
        executable(cask / "bin/redis-server", "exit 0\n")
        executable(cask / "bin/redis-cli", "exit 1\n")  # nothing answers on the port
        modules = cask / "lib/redis/modules"
        modules.mkdir(parents=True)
        for module in ("redisearch.so", "rejson.so"):
            (modules / module).write_text("")
        # The tap's current cask names only openssl@3; the module also links llvm@18.
        executable(self.prefix / "bin/brew", 'case "$1" in deps) echo openssl@3 ;; esac\n')
        opt = self.prefix / "opt"
        executable(self.prefix / "bin/otool", f"""echo "$2:"
case "$2" in
  *redisearch.so)
    echo "	{opt}/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0)"
    echo "	{opt}/llvm@18/lib/libunwind.1.dylib (compatibility version 1.0.0)"
    echo "	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)" ;;
esac
""")
        (opt / "openssl@3/lib").mkdir(parents=True)
        (opt / "openssl@3/lib/libssl.3.dylib").write_text("")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def plan(self) -> str:
        env = {
            "HOME": str(self.home),
            "PATH": f"{self.prefix / 'bin'}:/usr/bin:/bin",
            "MSEARCH_BREW_PREFIX": str(self.prefix),
            "MSEARCH_REDIS_PORT": "6399",
        }
        result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, check=True)
        return result.stdout

    def test_plan_names_the_formula_of_a_missing_linked_library(self) -> None:
        missing = [line for line in self.plan().splitlines() if "빠진 라이브러리" in line]
        self.assertEqual(len(missing), 1, missing)
        self.assertIn("llvm@18", missing[0])
        self.assertNotIn("openssl@3", missing[0])

    def test_plan_is_quiet_when_every_linked_library_is_there(self) -> None:
        libunwind = self.prefix / "opt/llvm@18/lib/libunwind.1.dylib"
        libunwind.parent.mkdir(parents=True)
        libunwind.write_text("")
        self.assertNotIn("빠진 라이브러리", self.plan())


if __name__ == "__main__":
    unittest.main()
