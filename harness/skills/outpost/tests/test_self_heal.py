from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ENGINE = load("run_aside_repl_outpost_heal", "run_aside_repl_outpost.py")
UI = ENGINE.UI
PROJECT = "https://chatgpt.com/g/g-p-test-work/project"


class Isolated(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.map_path = self.root / "outpost-ui.json"
        env = mock.patch.dict(
            os.environ,
            {
                "OUTPOST_SESSIONS_PATH": str(self.root / "sessions.json"),
                "OUTPOST_ASIDE_ROOT": str(self.root / "aside"),
                "OUTPOST_UI_MAP_PATH": str(self.map_path),
                "OUTPOST_AUTO_HEAL": "1",
            },
        )
        env.start()
        self.addCleanup(env.stop)


class ScreenMapTest(Isolated):
    def test_healing_cannot_redirect_to_a_legacy_or_future_family(self) -> None:
        for label in ("Legacy Sol", "GPT-5 Thinking", "GPT-7", "GPT-60", "최신", "Latest"):
            with self.subTest(label=label):
                clean, errors = UI.validate_overlay({"modelRadio": label})
                self.assertEqual(clean, {})
                self.assertTrue(errors)
        for label in UI.ALLOWED_MODEL_RADIOS:
            with self.subTest(label=label):
                clean, errors = UI.validate_overlay({"modelRadio": label})
                self.assertEqual(clean["modelRadio"], label)
                self.assertEqual(errors, [])

    def test_a_learned_name_is_tried_first_and_the_old_ones_still_work(self) -> None:
        UI.write_overlay({"tierSliderNames": ["Power"], "modelRadio": UI.DEFAULT_UI_MAP["modelRadio"]})
        ui = UI.load_ui_map()
        self.assertEqual(ui["tierSliderNames"][0], "Power")
        self.assertIn("파워", ui["tierSliderNames"])
        self.assertEqual(ui["modelRadio"], UI.DEFAULT_UI_MAP["modelRadio"])
        script = ENGINE.build_repl_script(
            project_url=PROJECT,
            quality="pro",
            packet_name="p.md",
            packet_path="/tmp/packet.md",
            topic="t",
            outpost_id="abc",
            response_timeout_ms=1000,
        )
        self.assertIn('var tierSliderNames = ["Power", "파워"', script)
        self.assertIn(f'var targetModel = "{UI.DEFAULT_UI_MAP["modelRadio"]}"', script)

    def test_the_map_refuses_what_would_spend_pro_or_pick_sol(self) -> None:
        clean, errors = UI.validate_overlay(
            {
                "tierLabels": {"xhigh": ["Pro"], "pro": ["Pro"]},
                "modelRadio": "Legacy Sol",
                "tierPositionPattern": "(\\d+) of (\\d+)",
                "madeUp": ["x"],
            }
        )
        self.assertEqual(clean, {"tierLabels": {"pro": ["Pro"]}})
        self.assertEqual(len(errors), 4)

    def test_a_heal_killed_mid_check_leaves_the_last_verified_map(self) -> None:
        UI.write_overlay({"modelRadio": "GPT-6", "tierSliderNames": ["Unverified"]})
        UI._pending_path(self.map_path).write_text(
            json.dumps({"pid": 999999999, "verified": {"modelRadio": "GPT-6"}}), encoding="utf-8"
        )
        self.assertEqual(UI.read_overlay(), {"modelRadio": "GPT-6"})
        self.assertFalse(UI._pending_path(self.map_path).exists())

    def test_a_broken_saved_map_falls_back_to_the_defaults(self) -> None:
        self.map_path.write_text("{not json", encoding="utf-8")
        self.assertEqual(UI.load_ui_map(), UI.merge({}))


def verify_sequence(*results):
    queue = list(results)

    def verify():
        return queue.pop(0)

    return verify


class HealLoopTest(Isolated):
    def heal(self, answers, verify, tries_per_step=3):
        asked = []

        def ask(prompt):
            asked.append(prompt)
            return answers.pop(0)

        result = UI.heal(
            failure={"ok": False, "stage": "select-tier", "detail": "menu not visible", "diag": {"tree": "- menuitem \"Power\""}},
            verify=verify,
            stage_rank=ENGINE.stage_rank,
            stage_hint=lambda stage: "",
            log=lambda line: None,
            ask=ask,
            tries_per_step=tries_per_step,
        )
        return result, asked

    def test_a_rewrite_that_passes_is_kept(self) -> None:
        result, asked = self.heal(
            ['sure: {"tierSliderNames": ["Power"]}'],
            verify_sequence({"ok": True, "stage": "ready-to-send"}),
        )
        self.assertTrue(result["ok"])
        self.assertEqual(UI.read_overlay()["tierSliderNames"], ["Power"])
        # the model saw the failing page
        self.assertIn('menuitem \\"Power\\"', json.dumps(asked[0]))

    def test_the_answer_is_read_past_a_preamble_with_braces(self) -> None:
        result, _ = self.heal(
            ['The {project} label changed.\n```json\n{"projectComposerLabels": ["{project}의 새 채팅"]}\n```'],
            verify_sequence({"ok": True, "stage": "ready-to-send"}),
        )
        self.assertTrue(result["ok"])
        self.assertEqual(UI.read_overlay()["projectComposerLabels"], ["{project}의 새 채팅"])

    def test_a_rewrite_that_gets_no_further_is_undone(self) -> None:
        result, asked = self.heal(
            ['{"tierSliderNames": ["Wrong"]}', "{}"],
            verify_sequence({"ok": False, "stage": "select-tier", "detail": "still"}),
            tries_per_step=2,
        )
        self.assertFalse(result["ok"])
        self.assertNotIn("tierSliderNames", UI.read_overlay())
        # the second try is told what the first one tried
        self.assertIn("Wrong", asked[1])

    def test_a_rewrite_that_gets_further_is_kept_and_the_next_step_is_healed(self) -> None:
        result, _ = self.heal(
            ['{"tierSliderNames": ["Power"]}', '{"fileInput": ["form input[type=file]"]}'],
            verify_sequence(
                {"ok": False, "stage": "attach-packet", "detail": "no input"},
                {"ok": True, "stage": "ready-to-send"},
            ),
        )
        self.assertTrue(result["ok"])
        overlay = UI.read_overlay()
        self.assertEqual(overlay["tierSliderNames"], ["Power"])
        self.assertEqual(overlay["fileInput"], ["form input[type=file]"])


class DoctorTest(Isolated):
    def run_doctor(self, *flags):
        args = ENGINE.parse_args(["--doctor", "--url", PROJECT, "--project", "Work", *flags])
        with mock.patch.object(ENGINE, "ensure_aside_daemon", return_value=None), mock.patch.object(
            ENGINE, "aside_daemon_health", return_value=None
        ):
            return ENGINE.run_doctor(args)

    def test_pro_is_only_rehearsed_and_xhigh_really_goes_out(self) -> None:
        with mock.patch.object(ENGINE, "rehearse", return_value={"ok": True, "stage": "ready-to-send"}) as rehearse, \
                mock.patch.object(ENGINE, "live_check", return_value={"ok": True, "sent": True, "stage": "answered"}) as live:
            self.assertEqual(self.run_doctor(), 0)
        self.assertEqual(rehearse.call_args.kwargs["quality"], "pro")
        live.assert_called_once()

    def test_a_broken_step_is_healed_and_doctor_passes(self) -> None:
        broken = {"ok": False, "stage": "select-tier", "detail": "tier button not visible"}
        with mock.patch.object(ENGINE, "rehearse", return_value=broken), \
                mock.patch.object(ENGINE, "heal_screen_map", return_value={"ok": True, "attempts": 2, "result": {"ok": True, "stage": "ready-to-send"}}) as heal, \
                mock.patch.object(ENGINE, "live_check", return_value={"ok": True, "sent": True, "stage": "answered"}):
            self.assertEqual(self.run_doctor(), 0)
        heal.assert_called_once()

    def test_no_heal_only_reports(self) -> None:
        broken = {"ok": False, "stage": "select-tier", "detail": "tier button not visible"}
        with mock.patch.object(ENGINE, "rehearse", return_value=broken), \
                mock.patch.object(ENGINE, "heal_screen_map") as heal, \
                mock.patch.object(ENGINE, "live_check") as live:
            self.assertEqual(self.run_doctor("--no-heal"), 75)
        heal.assert_not_called()
        live.assert_not_called()

    def test_a_rate_limit_is_not_a_screen_change(self) -> None:
        self.assertFalse(ENGINE.healable({"stage": "wait-project-composer", "detail": "ChatGPT rate-limited the project page"}))
        self.assertFalse(ENGINE.healable({"stage": "select-tier", "daemonLost": True}))
        self.assertFalse(ENGINE.healable({"stage": "commit-user-turn"}))
        self.assertTrue(ENGINE.healable({"stage": "attach-packet", "detail": "x"}))

    def test_the_live_check_is_an_xhigh_send_judged_by_the_model_that_answered(self) -> None:
        submit = {"quality": "xhigh", "tier": "Extra High (4 of 5)", "conversationUrl": "https://chatgpt.com/c/6ab8fe36-8580-83e8-97d3-9a07319a4d75"}
        for slug, ok in ((ENGINE.required_model_slug("xhigh"), True), (ENGINE.required_model_slug("pro"), False), ("legacy-thinking", False)):
            response = {"idMatched": True, "modelSlug": slug, "responseElapsedMs": 1000}
            with mock.patch.object(ENGINE, "build_repl_script", return_value="s") as build, \
                    mock.patch.object(ENGINE, "run_repl_outpost", return_value=(submit, response, 1.0, 1.0, "")), \
                    mock.patch.object(ENGINE, "run_repl_process", return_value='OUTPOST_HIDE_RESULT {"status": 200}'):
                result = ENGINE.live_check(project_url=PROJECT, project_name="Work")
            self.assertEqual(result["ok"], ok, slug)
            self.assertEqual(build.call_args.kwargs["quality"], "xhigh")
            self.assertFalse(build.call_args.kwargs.get("dry_run", False))
            self.assertTrue(result["cleanedUp"])

    def test_a_failure_carries_the_page_it_failed_on(self) -> None:
        transcript = (
            'OUTPOST_DIAG {"stage": "select-tier", "tree": "- button \\"X\\""}\n'
            "Error: OUTPOST_FAIL stage=select-tier tier button not visible\n"
        )
        failure = ENGINE.failure_from_transcript(transcript)
        self.assertEqual(failure["stage"], "select-tier")
        self.assertEqual(failure["diag"]["tree"], '- button "X"')


class SendAutoHealTest(Isolated):
    def send(self, side_effect, heal_result):
        packet = self.root / ".outpost" / "run" / "packet.md"
        packet.parent.mkdir(parents=True)
        packet.write_text("# Topic\n\nquestion", encoding="utf-8")
        result_path = packet.parent / "result.json"
        argv = [
            "--quality", "pro",
            "--packet", str(packet),
            "--url", PROJECT,
            "--response-output", str(packet.parent / "response.md"),
            "--json-output", str(result_path),
            "--stderr-output", str(packet.parent / "stderr.log"),
        ]
        with mock.patch.object(ENGINE.shutil, "which", return_value="/bin/aside"), \
                mock.patch.object(ENGINE, "ensure_aside_daemon", return_value=None), \
                mock.patch.object(ENGINE, "run_repl_outpost", side_effect=side_effect) as sends, \
                mock.patch.object(ENGINE, "heal_screen_map", return_value=heal_result) as heal:
            code = ENGINE.main(argv)
        return code, sends, heal, json.loads(result_path.read_text(encoding="utf-8"))

    UNSENT = RuntimeError("exit 75\nError: OUTPOST_FAIL stage=select-tier tier button not visible")
    DONE = (
        {"quality": "pro", "model": "GPT-6", "tier": "Pro (5 of 5)", "conversationUrl": "https://chatgpt.com/c/6ab8fe36-8580-83e8-97d3-9a07319a4d75", "targetId": "t", "submitElapsedMs": 1000},
        {"responseText": "answer", "idMatched": True, "modelSlug": "gpt-6-pro", "responseElapsedMs": 1000},
        1.0,
        1.0,
        "",
    )

    def test_an_unsent_screen_failure_is_healed_and_sent_once_more(self) -> None:
        code, sends, heal, result = self.send([self.UNSENT, self.DONE], {"ok": True, "attempts": 1, "result": {"ok": True}})
        self.assertEqual(code, 0)
        self.assertEqual(sends.call_count, 2)
        heal.assert_called_once()
        self.assertTrue(result["ok"])

    def test_an_unhealed_failure_stays_unsent_and_can_be_sent_again(self) -> None:
        code, sends, _, result = self.send([self.UNSENT], {"ok": False, "attempts": 4, "result": {"stage": "select-tier"}})
        self.assertEqual(code, 75)
        self.assertEqual(sends.call_count, 1)
        self.assertEqual(result["status"], "not_sent")
        # the duplicate guard lets the same packet go again
        code, sends, _, _ = self.send_again([self.DONE])
        self.assertEqual(code, 0)

    def send_again(self, side_effect):
        packet = self.root / ".outpost" / "run" / "packet.md"
        argv = [
            "--quality", "pro",
            "--packet", str(packet),
            "--url", PROJECT,
            "--response-output", str(packet.parent / "response.md"),
            "--json-output", str(packet.parent / "result.json"),
            "--stderr-output", str(packet.parent / "stderr.log"),
        ]
        with mock.patch.object(ENGINE.shutil, "which", return_value="/bin/aside"), \
                mock.patch.object(ENGINE, "ensure_aside_daemon", return_value=None), \
                mock.patch.object(ENGINE, "run_repl_outpost", side_effect=side_effect) as sends:
            return ENGINE.main(argv), sends, None, None

    def test_a_send_that_may_have_gone_out_is_never_retried(self) -> None:
        unknown = ENGINE.SubmitUnknownError("OUTPOST_FAIL stage=select-tier maybe sent")
        code, sends, heal, _ = self.send([unknown], {"ok": True, "attempts": 1, "result": {}})
        self.assertEqual(code, 76)
        self.assertEqual(sends.call_count, 1)
        heal.assert_not_called()


if __name__ == "__main__":
    unittest.main()
