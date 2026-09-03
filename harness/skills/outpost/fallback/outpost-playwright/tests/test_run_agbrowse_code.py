from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).resolve().parents[1] / "scripts" / "run_agbrowse_code.py"
sys.path.insert(0, str(HELPER.parent))


FAKE_AGBROWSE = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
from zipfile import ZipFile


def value(name):
    return sys.argv[sys.argv.index(name) + 1]


record = Path(os.environ["FAKE_AGBROWSE_RECORD"])
record.write_text(json.dumps({"argv": sys.argv[1:], "cdpPort": os.environ.get("CDP_PORT"), "autoStart": os.environ.get("AGBROWSE_WEB_AI_AUTO_START")}), encoding="utf-8")
output = Path(value("--output-zip"))
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, "w") as archive:
    archive.writestr("PLAN.md", "# plan\n")
print(json.dumps({"artifact": {"outputPath": str(output)}}))
'''


FAKE_LAUNCHER = r'''#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LAUNCHER_RECORD"
'''


class ConsultCodeChromeRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.agbrowse = self.bin_dir / "agbrowse"
        self.agbrowse.write_text(FAKE_AGBROWSE, encoding="utf-8")
        self.agbrowse.chmod(0o755)
        self.launcher = self.root / "codex-chrome-devtools-mcp"
        self.launcher.write_text(FAKE_LAUNCHER, encoding="utf-8")
        self.launcher.chmod(0o755)
        self.agbrowse_record = self.root / "agbrowse.json"
        self.launcher_record = self.root / "launcher.txt"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_code_mode_uses_shared_chrome_and_a_dedicated_tab(self) -> None:
        spec = importlib.util.spec_from_file_location("run_agbrowse_code_test", HELPER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bin_dir}{os.pathsep}{env.get('PATH', '')}",
            "FAKE_AGBROWSE_RECORD": str(self.agbrowse_record),
            "FAKE_LAUNCHER_RECORD": str(self.launcher_record),
            "OUTPOST_BROWSER_AGENT_HOME": str(self.root / "browser-home"),
            "OUTPOST_CHROME_LAUNCHER": str(self.launcher),
            "CDP_PORT": "9223",
            "AGBROWSE_WEB_AI_AUTO_START": "1",
            "OUTPOST_CHATGPT_URL": "https://chatgpt.com/g/g-p-test-work/project",
        })
        previous = os.environ.copy()
        os.environ.clear()
        os.environ.update(env)
        try:
            result = module.main([
                "--quality", "xhigh",
                "--prompt", "make a small test artifact",
                "--output-zip", str(self.root / "artifact.zip"),
                "--json-output", str(self.root / "result.json"),
                "--stderr-output", str(self.root / "stderr.log"),
            ])
        finally:
            os.environ.clear()
            os.environ.update(previous)

        self.assertEqual(result, 0)
        self.assertEqual(
            self.launcher_record.read_text(encoding="utf-8").splitlines(),
            ["--ensure", "--hide-if-idle"],
        )
        invocation = json.loads(self.agbrowse_record.read_text(encoding="utf-8"))
        self.assertEqual(invocation["cdpPort"], "9222")
        self.assertEqual(invocation["autoStart"], "0")
        self.assertIn("--parallel", invocation["argv"])

    def test_work_url_validator_rejects_global_chat(self) -> None:
        spec = importlib.util.spec_from_file_location("run_agbrowse_code_url_test", HELPER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        self.assertTrue(
            module.is_work_project_url("https://chatgpt.com/g/g-p-test-work/project")
        )
        self.assertFalse(module.is_work_project_url("https://chatgpt.com/"))
        self.assertFalse(module.is_work_project_url("https://chatgpt.com/c/global"))

    def test_missing_quality_is_rejected(self) -> None:
        spec = importlib.util.spec_from_file_location("run_agbrowse_code_quality_test", HELPER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        self.assertEqual(module.main([]), 2)


if __name__ == "__main__":
    unittest.main()
