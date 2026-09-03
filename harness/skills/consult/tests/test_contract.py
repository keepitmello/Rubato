from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent


class ConsultAsideContractTest(unittest.TestCase):
    def test_main_skill_stays_thin_and_points_at_consult_cli(self) -> None:
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("consult list", skill)
        self.assertIn("consult send", skill)
        self.assertIn("consult recover", skill)
        self.assertIn("--quality xhigh", skill)
        self.assertIn("--quality pro", skill)
        self.assertIn("With no flag", skill)
        self.assertIn("--to", skill)
        self.assertIn("Exit `77`", skill)
        self.assertIn("references/runbook.md", skill)
        self.assertIn("references/after-advice.md", skill)
        self.assertIn("references/context-checklist.md", skill)
        self.assertLess(len(skill.splitlines()), 80)
        self.assertNotIn("run_agbrowse", skill)
        self.assertNotIn("ensure_consult_chrome", skill)
        self.assertNotIn("data-tpp-toggle-value", skill)
        self.assertNotIn("submitElapsedSeconds", skill)
        self.assertNotIn("run_aside_repl_consult.py", skill)

    def test_runbook_keeps_the_engine_contract(self) -> None:
        runbook = (ROOT / "references" / "runbook.md").read_text(encoding="utf-8")

        self.assertIn("run_aside_repl_consult.py", runbook)
        self.assertIn("under 120 seconds", runbook)
        self.assertIn("submitElapsedSeconds", runbook)
        self.assertIn("same project page", runbook)
        self.assertIn("configured project path", runbook)
        self.assertIn("CONSULT_PROJECT_NAME", runbook)
        self.assertIn("There is no automatic alternate sender", runbook)
        self.assertIn("--artifact-output", runbook)
        self.assertIn("Playwright is not part of Consult", runbook)
        self.assertIn("conversationUrl", runbook)
        self.assertIn("backend-api", runbook)
        self.assertIn("targetId", runbook)
        self.assertIn("deliberate resend", runbook)
        self.assertIn("--thread", runbook)
        self.assertIn("--conversation-url", runbook)
        self.assertIn("consult-sessions.json", runbook)
        self.assertNotIn("contains `-work/`", runbook)
        self.assertNotIn("ChatGPT Work 프로젝트", runbook)

    def test_inner_skill_fails_closed_outside_work(self) -> None:
        skill = (
            ROOT / "aside-skill" / "chatgpt-work-consult" / "SKILL.md"
        ).read_text(encoding="utf-8")

        self.assertIn("Never use temporary chat", skill)
        self.assertIn("Never submit from global Chat", skill)
        self.assertIn("Never send from Work mode", skill)
        self.assertIn('data-tpp-toggle-value="chatgpt"', skill)
        self.assertIn("GPT-5.6 Sol", skill)
        self.assertIn("매우 높음", skill)
        self.assertIn("`xhigh`: **매우 높음**", skill)
        self.assertIn("`pro`: **Pro**", skill)
        self.assertIn("QUALITY: xhigh", skill)
        self.assertIn("QUALITY: pro", skill)
        self.assertIn("SURFACE: Chat", skill)
        self.assertIn("TIER: 매우 높음 (N of M)", skill)
        self.assertIn("TIER: Pro (N of M)", skill)
        self.assertIn("ASIDE_WORK_CONSULT_ERROR", skill)
        self.assertLess(
            skill.index("In the simple tier view"),
            skill.index("Only after the tier is verified"),
        )
        self.assertIn("joining each direct child", skill)
        self.assertIn("Do not compare\n   `innerText`", skill)

    def test_playwright_fallback_is_hidden_not_main_content(self) -> None:
        fallback = ROOT / "fallback" / "consult-playwright"
        if fallback.is_symlink():
            self.assertEqual(
                fallback.resolve(), (REPO / "consult-playwright").resolve()
            )
        else:
            self.assertTrue(fallback.is_dir())
        self.assertTrue((fallback / "SKILL.md").is_file())
        self.assertFalse((ROOT / "scripts" / "run_agbrowse_consult.py").exists())


if __name__ == "__main__":
    unittest.main()
