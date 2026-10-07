from __future__ import annotations

import importlib.util
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile


SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "run_aside_repl_outpost.py"
)
SPEC = importlib.util.spec_from_file_location("run_aside_repl_outpost_guards", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


FAKE_ASIDE = """#!/usr/bin/env python3
import pathlib, sys
pathlib.Path(SENTINEL).write_text("ran", encoding="utf-8")
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"GPT-6","tier":"Pro (5 of 5)","submitElapsedMs":1200,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef","targetId":"t"}')
print('ASIDE_REPL_RESPONSE_RESULT {"modelSlug":"SLUG","responseText":"answer","idMatched":true,"packetUnread":false,"responseElapsedMs":900,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef"}')
"""


class ModelAndLossGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self._sessions_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._sessions_dir.cleanup)
        env = mock.patch.dict(
            os.environ,
            {
                "OUTPOST_SESSIONS_PATH": str(Path(self._sessions_dir.name) / "sessions.json"),
                "OUTPOST_ASIDE_ROOT": str(Path(self._sessions_dir.name) / "aside"),
                # A test never reads the machine's learned screen map or calls
                # the heal model unless it asks to.
                "OUTPOST_UI_MAP_PATH": str(Path(self._sessions_dir.name) / "outpost-ui.json"),
                "OUTPOST_AUTO_HEAL": "0",
            },
        )
        env.start()
        self.addCleanup(env.stop)

    def _run(
        self,
        root: Path,
        slug: str,
        *,
        quality: str = "pro",
        body: str = "# Topic\n\nquestion",
    ) -> tuple[int, Path, Path]:
        sentinel = root / "aside-ran"
        fake = root / "aside"
        fake.write_text(
            FAKE_ASIDE.replace("SENTINEL", json.dumps(str(sentinel))).replace("SLUG", slug),
            encoding="utf-8",
        )
        fake.chmod(0o755)
        packet = root / "packet.md"
        packet.write_text(body, encoding="utf-8")
        response_path = root / "response.md"
        result_path = root / "result.json"
        path = f"{root}{os.pathsep}{os.environ.get('PATH', '')}"
        with mock.patch.dict(os.environ, {"PATH": path}):
            with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                with mock.patch.object(MODULE, "recover_outpost_from_backend", return_value=None):
                    code = MODULE.main(
                        [
                            "--quality", quality,
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(response_path),
                            "--json-output", str(result_path),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
        return code, result_path, sentinel

    def test_daemon_uptime_and_its_display(self) -> None:
        now = datetime.now(timezone.utc)
        health = {"startedAt": (now - timedelta(seconds=125)).isoformat().replace("+00:00", "Z")}
        self.assertAlmostEqual(MODULE.daemon_uptime_seconds(health) or 0, 125, delta=5)
        self.assertEqual(MODULE.format_daemon_uptime(health), "2m")
        self.assertEqual(MODULE.format_daemon_uptime({"startedAt": "not-a-date"}), "unknown")
        self.assertEqual(MODULE.format_daemon_uptime(None), "unknown")

    def test_a_settling_daemon_holds_the_send(self) -> None:
        fresh = {"startedAt": datetime.now(timezone.utc).isoformat(), "ready": True}
        with mock.patch.object(MODULE, "aside_daemon_health", return_value=fresh):
            self.assertIn("has not settled", MODULE.wait_for_settled_daemon(0.01) or "")
        settled = {
            "startedAt": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
            "ready": True,
        }
        with mock.patch.object(MODULE, "aside_daemon_health", return_value=settled):
            self.assertIsNone(MODULE.wait_for_settled_daemon(0.01))

    def test_an_unreadable_health_endpoint_never_blocks(self) -> None:
        # The endpoint is a bonus: not reading it is not evidence of a daemon
        # that is about to restart.
        with mock.patch.object(MODULE, "aside_daemon_health", return_value=None):
            self.assertIsNone(MODULE.wait_for_settled_daemon(0.01))

    def test_the_daemon_check_holds_a_send_that_would_race_a_restart(self) -> None:
        with mock.patch.object(MODULE, "aside_repl_ping", return_value=True):
            with mock.patch.object(
                MODULE, "wait_for_settled_daemon", return_value="has not settled"
            ) as settle:
                self.assertEqual(MODULE.ensure_aside_daemon(), "has not settled")
        settle.assert_called_once()

    def test_a_failure_message_yields_the_stage_for_the_turn_record(self) -> None:
        stage, detail = MODULE.failure_reason_from(
            "exit 75 — 전송 안 됨\n"
            "단계: select-tier (추론 수준/Pro 버튼)\n"
            "tier button not visible: expected ...\n"
        )
        self.assertEqual(stage, "select-tier")
        self.assertEqual(detail, "exit 75 — 전송 안 됨")

    def test_a_failure_without_a_stage_line_still_yields_a_detail(self) -> None:
        stage, detail = MODULE.failure_reason_from("aside daemon is not reachable")
        self.assertEqual(stage, "")
        self.assertEqual(detail, "aside daemon is not reachable")

    def test_each_quality_expects_exactly_one_model(self) -> None:
        self.assertEqual(tuple(MODULE.QUALITIES), ("pro", "xhigh"))
        for quality, slug in MODULE.QUALITY_MODEL_SLUGS.items():
            self.assertTrue(slug.startswith("gpt-6-"))
            self.assertEqual(MODULE.required_model_slug(quality), slug)
        self.assertNotEqual(MODULE.required_model_slug("pro"), MODULE.required_model_slug("xhigh"))
        # Recovery uses the same pinned model contract as a new send.
        self.assertEqual(MODULE.required_model_slug("xhigh"), MODULE.QUALITY_MODEL_SLUGS["xhigh"])

    def test_a_model_other_than_the_quality_asked_for_fails_the_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result_path, _sentinel = self._run(root, "legacy-thinking")
            self.assertEqual(code, MODULE.WRONG_MODEL_EXIT)
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertFalse(evidence["ok"])
            self.assertFalse(evidence["modelOk"])
            self.assertEqual(evidence["modelSlug"], "legacy-thinking")
            self.assertEqual(evidence["requiredModel"], MODULE.required_model_slug("pro"))
            # the answer is still saved, so quota is never silently thrown away
            self.assertIn("answer", (root / "response.md").read_text(encoding="utf-8"))

    def test_xhigh_passes_on_its_pinned_gpt_6_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result_path, _sentinel = self._run(
                root, MODULE.required_model_slug("xhigh"), quality="xhigh"
            )
            self.assertEqual(code, 0)
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertTrue(evidence["modelOk"])
            self.assertEqual(evidence["quality"], "xhigh")
            self.assertEqual(evidence["requiredModel"], MODULE.required_model_slug("xhigh"))

    def test_every_quality_rejects_a_legacy_model_and_preserves_the_answer(self) -> None:
        for quality in MODULE.QUALITIES:
            with self.subTest(quality=quality), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                code, result_path, _ = self._run(root, "legacy-thinking", quality=quality)
                self.assertEqual(code, MODULE.WRONG_MODEL_EXIT)
                evidence = json.loads(result_path.read_text(encoding="utf-8"))
                self.assertFalse(evidence["modelOk"])
                self.assertEqual(evidence["requiredModel"], MODULE.required_model_slug(quality))
                self.assertIn("answer", (root / "response.md").read_text(encoding="utf-8"))

    def test_xhigh_on_the_pro_model_fails_the_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result_path, _sentinel = self._run(root, "gpt-6-pro", quality="xhigh")
            self.assertEqual(code, MODULE.WRONG_MODEL_EXIT)
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertFalse(evidence["modelOk"])
            self.assertEqual(evidence["requiredModel"], MODULE.required_model_slug("xhigh"))

    def test_gpt_6_pro_passes_and_records_the_server_slug(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result_path, _sentinel = self._run(root, "gpt-6-pro")
            self.assertEqual(code, 0)
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertTrue(evidence["modelOk"])
            self.assertEqual(evidence["model"], "gpt-6-pro")
            self.assertTrue(evidence["packetSha"])

    def test_the_same_packet_is_never_sent_twice_from_one_run_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first, result_path, sentinel = self._run(root, "gpt-6-pro")
            self.assertEqual(first, 0)
            sentinel.unlink()
            second, _result_path, sentinel = self._run(root, "gpt-6-pro")
            self.assertEqual(second, MODULE.DUPLICATE_SEND_EXIT)
            self.assertFalse(sentinel.exists(), "duplicate send must not reach the browser")
            with mock.patch.dict(os.environ, {"OUTPOST_FORCE": "1"}):
                forced, _result_path, sentinel = self._run(root, "gpt-6-pro")
            self.assertEqual(forced, 0)
            self.assertTrue(sentinel.exists())

    def test_result_json_exists_before_the_reply_so_nothing_is_lost(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            result_path = root / "result.json"
            during = root / "result.during.json"
            fake.write_text(
                "#!/usr/bin/env python3\nimport shutil\n"
                f"shutil.copyfile({str(result_path)!r}, {str(during)!r})\n"
                "print('Error: OUTPOST_FAIL stage=select-tier tier button not visible')\n",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Topic\n\nquestion", encoding="utf-8")
            path = f"{root}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    with mock.patch.object(MODULE, "recover_outpost_from_backend", return_value=None):
                        MODULE.main(
                            [
                                "--quality", "pro",
                                "--packet", str(packet),
                                "--url", "https://chatgpt.com/g/g-p-test-work/project",
                                "--response-output", str(root / "response.md"),
                                "--json-output", str(result_path),
                                "--stderr-output", str(root / "stderr.log"),
                            ]
                        )
            # written before the send, so a dead REPL still leaves a recoverable turn
            pending = json.loads(during.read_text(encoding="utf-8"))
            self.assertEqual(pending["status"], "submitted_pending")
            self.assertTrue(pending["id"])
            self.assertTrue(pending["packetSha"])
            # recover can find the turn by its id in this project later
            self.assertEqual(pending["projectUrl"], "https://chatgpt.com/g/g-p-test-work/project")
            self.assertTrue(pending["startedAt"])
            # this send died before the click, so the run must not look sent:
            # sending the same packet again is the fix, not a duplicate (exit 79)
            final = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual(final["status"], "not_sent")
            self.assertEqual(final["packetSha"], pending["packetSha"])

    def test_non_ascii_upload_names_are_renamed_before_upload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            korean = root / "자소서-재료.md"
            korean.write_text("hello", encoding="utf-8")
            bundle = root / "evidence.zip"
            with ZipFile(bundle, "w") as archive:
                archive.writestr("조사/01-방법론.md", "a")
                archive.writestr("plain.md", "b")

            uploads, notes = MODULE.build_uploads([str(korean), str(bundle)])

            self.assertEqual(len(uploads), 2)
            for upload in uploads:
                self.assertTrue(MODULE.is_ascii(upload["name"]), upload["name"])
            self.assertTrue(any("자소서-재료.md" in note for note in notes))
            self.assertTrue(any("01-방법론.md" in note for note in notes))

            repacked = root / "repacked.zip"
            repacked.write_bytes(uploads[1]["data"])
            with ZipFile(repacked) as archive:
                names = archive.namelist()
            for name in names:
                self.assertTrue(MODULE.is_ascii(name), name)
            self.assertIn("FILENAMES.txt", names)
            self.assertIn("plain.md", names)

    def test_every_role_lookup_is_primed_by_a_snapshot(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
            topic="t",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        self.assertIn("async function primeRoles(target)", script)
        self.assertIn("waitNamedRef(workPage, 'button', tierNameRe", script)
        self.assertIn("waitRole(workPage, 'menuitem', tierSliderNames[sliderIndex]", script)
        self.assertIn("waitNamedRef(workPage, 'menuitemradio', modelNameRe", script)
        self.assertIn("waitRole(workPage, 'group', attachmentName", script)
        # a bare role lookup before the first snapshot silently matches nothing
        self.assertNotIn("workPage.getByRole('heading'", script.split("await primeRoles")[0])

    def test_no_regexp_name_reaches_get_by_role(self) -> None:
        # getByRole(role, {name}) silently matches nothing when the name is a
        # RegExp, and it never sees a name that comes from the element's own
        # text. Both the Pro pill and the model radios are named by their text,
        # so a RegExp handed to a role lookup kills the send without a word.
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
            topic="t",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        self.assertNotIn("name: /", script)
        self.assertNotIn("waitRole(workPage, 'button', tierNameRe", script)
        self.assertNotIn("waitRole(workPage, 'menuitemradio', modelNameRe", script)

    def test_a_project_page_that_will_not_render_is_named(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
            topic="t",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        self.assertIn("client error \"Try again\"", script)
        self.assertIn("await target.reload()", script)


if __name__ == "__main__":
    unittest.main()
