from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "consult_runtime.py"
SPEC = importlib.util.spec_from_file_location("consult_runtime_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConsultRuntimeTest(unittest.TestCase):
    def test_browser_contract_overrides_ambient_agbrowse_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            env = MODULE.browser_env({
                "BROWSER_AGENT_HOME": "/tmp/wrong-profile",
                "CDP_PORT": "9333",
                "AGBROWSE_WEB_AI_AUTO_START": "1",
                "CONSULT_BROWSER_AGENT_HOME": str(root / "consult-home"),
            })

        self.assertEqual(env["BROWSER_AGENT_HOME"], str(root / "consult-home"))
        self.assertEqual(env["CDP_PORT"], "9222")
        self.assertEqual(env["AGBROWSE_WEB_AI_AUTO_START"], "0")

    def test_packaged_launcher_is_the_default(self) -> None:
        launcher = MODULE.chrome_launcher({})

        self.assertEqual(launcher.name, "ensure_consult_chrome.py")
        self.assertEqual(launcher.parent, SCRIPT.parent)

    def test_launcher_creates_a_bootstrap_tab_for_normal_app_termination(self) -> None:
        launcher_source = MODULE.chrome_launcher({}).read_text(encoding="utf-8")

        self.assertIn('                "about:blank",', launcher_source)
        self.assertIn('"--disable-features=MacAppCodeSignClone', launcher_source)
        self.assertNotIn('"--no-startup-window"', launcher_source)


if __name__ == "__main__":
    unittest.main()
