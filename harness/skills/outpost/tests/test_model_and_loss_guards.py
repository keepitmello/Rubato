from __future__ import annotations

import importlib.util
import json
import os
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
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"최신","tier":"Pro (5 of 5)","submitElapsedMs":1200,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef","targetId":"t"}')
print('ASIDE_REPL_RESPONSE_RESULT {"modelSlug":"SLUG","responseText":"answer","idMatched":true,"packetUnread":false,"responseElapsedMs":900,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef"}')
"""


class ModelAndLossGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self._sessions_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._sessions_dir.cleanup)
        env = mock.patch.dict(
            os.environ,
            {"OUTPOST_SESSIONS_PATH": str(Path(self._sessions_dir.name) / "sessions.json")},
        )
        env.start()
        self.addCleanup(env.stop)

    def _run(self, root: Path, slug: str, *, body: str = "# Topic\n\nquestion") -> tuple[int, Path, Path]:
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
                            "--quality", "pro",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(response_path),
                            "--json-output", str(result_path),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
        return code, result_path, sentinel

    def test_a_model_other_than_gpt_6_pro_fails_the_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result_path, _sentinel = self._run(root, "gpt-5-6-thinking")
            self.assertEqual(code, MODULE.WRONG_MODEL_EXIT)
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertFalse(evidence["ok"])
            self.assertFalse(evidence["modelOk"])
            self.assertEqual(evidence["modelSlug"], "gpt-5-6-thinking")
            self.assertEqual(evidence["requiredModel"], "gpt-6-pro")
            # the answer is still saved, so quota is never silently thrown away
            self.assertIn("answer", (root / "response.md").read_text(encoding="utf-8"))

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
            fake.write_text("#!/usr/bin/env python3\nprint('nothing')\n", encoding="utf-8")
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Topic\n\nquestion", encoding="utf-8")
            result_path = root / "result.json"
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
            self.assertTrue(result_path.is_file())
            pending = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual(pending["status"], "submitted_pending")
            self.assertTrue(pending["id"])
            self.assertTrue(pending["packetSha"])

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
            repacked.write_bytes(
                __import__("base64").b64decode(uploads[1]["base64"])
            )
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
            packet_base64="cGFja2V0",
            topic="t",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        self.assertIn("async function primeRoles(target)", script)
        self.assertIn("waitRole(workPage, 'button', tierNameRe", script)
        self.assertIn("waitRole(workPage, 'menuitem', '성능'", script)
        self.assertIn("waitRole(workPage, 'menuitemradio', modelNameRe", script)
        self.assertIn("waitRole(workPage, 'group', attachmentName", script)
        # a bare role lookup before the first snapshot silently matches nothing
        self.assertNotIn("workPage.getByRole('heading'", script.split("await primeRoles")[0])

    def test_a_project_page_that_will_not_render_is_named(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_base64="cGFja2V0",
            topic="t",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        self.assertIn("client error \"Try again\"", script)
        self.assertIn("await target.reload()", script)


if __name__ == "__main__":
    unittest.main()
