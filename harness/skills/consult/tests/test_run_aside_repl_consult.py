from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "run_aside_repl_consult.py"
)
SPEC = importlib.util.spec_from_file_location("run_aside_repl_consult_test", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AsideReplConsultTest(unittest.TestCase):
    def test_quality_flag_is_required_and_limited(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.parse_args([])
        self.assertEqual(MODULE.parse_args(["--quality", "xhigh", "--packet", "p"]).quality, "xhigh")
        self.assertEqual(MODULE.parse_args(["--quality", "pro", "--packet", "p"]).quality, "pro")
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["--quality", "high", "--packet", "p"])

    def test_project_url_is_fail_closed_without_requiring_work_slug(self) -> None:
        self.assertTrue(
            MODULE.is_chatgpt_project_url(
                "https://chatgpt.com/g/g-p-test-work/project"
            )
        )
        self.assertTrue(
            MODULE.is_chatgpt_project_url(
                "https://chatgpt.com/g/g-p-test-shopping/project"
            )
        )
        self.assertFalse(MODULE.is_chatgpt_project_url("https://chatgpt.com/"))
        self.assertFalse(
            MODULE.is_chatgpt_project_url(
                "https://chatgpt.com/g/g-p-test-work/c/conversation"
            )
        )

    def test_project_name_comes_from_config_and_drives_composer_label(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "consult.env"
            config.write_text(
                "CONSULT_PROJECT_NAME=Shopping\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CONSULT_PROJECT_NAME", None)
                self.assertEqual(
                    MODULE.resolve_project_name(
                        cli_value=None,
                        config_path=config,
                    ),
                    "Shopping",
                )
                self.assertEqual(
                    MODULE.resolve_project_name(
                        cli_value="예창패",
                        config_path=config,
                    ),
                    "예창패",
                )
        self.assertEqual(MODULE.composer_aria_label("Shopping"), "Shopping에서 새 채팅")
        shopping = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-shopping/project",
            project_name="Shopping",
            quality="xhigh",
            packet_name="packet.md",
            packet_base64="cGFja2V0",
            topic="프로젝트 전환",
            consult_id="abc123",
            response_timeout_ms=1000,
        )
        self.assertIn(
            """#prompt-textarea[contenteditable="true"][aria-label="' + composerLabel + '"]""",
            shopping,
        )
        self.assertNotIn(".and(", shopping)
        self.assertIn("Shopping에서 새 채팅", shopping)
        self.assertNotIn("Work에서 새 채팅", shopping)
        self.assertIn("project composer not visible", shopping)

    def test_generated_script_has_quality_mapping_and_hard_deadline(self) -> None:
        xhigh = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="xhigh",
            packet_name="packet.md",
            packet_base64="cGFja2V0",
            topic="병렬 세션 탭 소유권",
            consult_id="abc123",
            response_timeout_ms=1000,
        )
        pro = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_base64="cGFja2V0",
            topic="병렬 세션 탭 소유권",
            consult_id="abc123",
            response_timeout_ms=1000,
            artifact_output="/tmp/artifact.zip",
        )

        self.assertEqual(MODULE.SUBMIT_TIMEOUT_SECONDS, 120)
        self.assertIn("var targetIndex = 4", xhigh)
        self.assertIn("var targetIndex = 5", pro)
        self.assertIn("병렬 세션 탭 소유권\\nID: abc123", pro)
        self.assertIn("ID missing from assistant response", pro)
        self.assertIn("pre-submit preparation exceeded 110 seconds", pro)
        self.assertIn("user turn committed after 120-second deadline", pro)
        self.assertIn("submitElapsedMs >= 120000", pro)
        self.assertIn("Promise.race", pro)
        self.assertIn("pre-submit preparation exceeded 110 seconds", pro)
        self.assertIn("ASIDE_REPL_SUBMIT_UNKNOWN", pro)
        self.assertIn("ASIDE_REPL_SUBMIT_RESULT", pro)
        self.assertIn("send.click({ timeout: remainingSubmitMs })", pro)
        self.assertIn("ASIDE_REPL_RESPONSE_RESULT", pro)
        self.assertIn("Buffer.from(packetBase64, 'base64')", pro)
        self.assertIn("name: packetName", pro)
        self.assertIn("setInputFiles([{", pro)
        self.assertNotIn("setInputFiles(packetPath)", pro)
        self.assertIn('#prompt-textarea[contenteditable="true"]', pro)
        self.assertNotIn(".and(", pro)
        self.assertIn("Work에서 새 채팅", pro)
        self.assertIn("project composer not visible", pro)
        self.assertIn("composer.press('Meta+A')", pro)
        self.assertIn("composer.press('Backspace')", pro)
        self.assertIn("keyboard.insertText(composerPrompt)", pro)
        self.assertIn("Array.from(el.children)", pro)
        self.assertIn("composerValue !== composerPrompt", pro)
        self.assertIn(
            '#composer-submit-button:not(:disabled):not([aria-disabled="true"]):not([data-visually-disabled])',
            pro,
        )
        self.assertIn("#upload-files", pro)
        self.assertIn("getByText(packetName, { exact: true })", pro)
        self.assertIn("attachmentChip.waitFor", pro)
        self.assertIn("data:text/html,<title>", pro)
        self.assertIn("tab.title === ownershipMarker", pro)
        self.assertIn("ownedTabs.length !== 1", pro)
        self.assertNotIn("idsBeforeOpen", pro)
        self.assertNotIn("composer.fill(composerPrompt)", pro)
        self.assertNotIn("composer.innerText()", pro)
        self.assertNotIn("composer canonical text mismatch", pro)
        self.assertIn("waitForEvent('download'", pro)
        self.assertIn("download.path()", pro)
        self.assertNotIn("download.saveAs", pro)
        self.assertIn("assistant.locator('button')", pro)
        self.assertIn("hasText: /\\.zip$/i", pro)
        self.assertNotIn("attachBrowserTab(targetId)", pro)

    def test_packet_topic_requires_the_first_line_h1(self) -> None:
        self.assertEqual(
            MODULE.extract_topic("# 병렬 세션 탭 소유권\n\nBody"),
            "병렬 세션 탭 소유권",
        )
        with self.assertRaisesRegex(ValueError, "Markdown H1"):
            MODULE.extract_topic("병렬 세션 탭 소유권\n\nBody")
        with self.assertRaisesRegex(ValueError, "empty"):
            MODULE.extract_topic("# \n\nBody")

    def test_main_rejects_packet_without_h1_before_submission(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("Missing title\n\nBody", encoding="utf-8")
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                result = MODULE.main(
                    [
                        "--quality", "xhigh",
                        "--packet", str(packet),
                        "--url", "https://chatgpt.com/g/g-p-test-work/project",
                    ]
                )
        self.assertEqual(result, 2)

    def test_composer_prompt_preserves_title_id_and_korean_contract(self) -> None:
        advice = MODULE.build_composer_prompt("병렬 세션 탭 소유권", "abc123", None)
        artifact = MODULE.build_composer_prompt(
            "병렬 세션 탭 소유권",
            "abc123",
            "/tmp/artifact.zip",
        )

        for prompt in (advice, artifact):
            self.assertTrue(prompt.startswith("병렬 세션 탭 소유권\nID: abc123\n\n"))
            self.assertIn("첨부한 독립형 컨텍스트 패킷", prompt)
            self.assertIn("이전 대화는 볼 수 없다고 가정", prompt)
            self.assertIn("근거가 패킷에 부족하면", prompt)
            self.assertIn("한국어 보고서", prompt)
            self.assertIn("자연스럽고 이해하기 쉽게", prompt)
            self.assertIn("기술 용어와 영문 표현", prompt)
            self.assertIn("답변 첫 줄에 위 ID를 그대로", prompt)
        self.assertNotIn("zip 파일", advice)
        self.assertIn("zip 파일 하나", artifact)

    def test_zip_artifact_requires_a_nonempty_valid_archive(self) -> None:
        from zipfile import ZipFile

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            valid = root / "valid.zip"
            empty = root / "empty.zip"
            with ZipFile(valid, "w") as archive:
                archive.writestr("src/main.py", "print('ok')\n")
            with ZipFile(empty, "w"):
                pass

            self.assertTrue(MODULE.zip_is_valid(valid))
            self.assertFalse(MODULE.zip_is_valid(empty))

    def test_repl_stdin_command_is_one_line_and_preserves_script(self) -> None:
        script = 'console.log("first")\nawait Promise.resolve()\nconsole.log("last")'
        command = MODULE.repl_stdin_command(script)

        self.assertEqual(command.count("\n"), 1)
        self.assertTrue(command.endswith("\n"))
        self.assertIn("Object.getPrototypeOf(async function(){}).constructor", command)
        self.assertIn("\\nawait Promise.resolve()\\n", command)

    def test_single_repl_runner_parses_both_markers(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}')
print('ASIDE_REPL_RESPONSE_RESULT {"responseText":"ID: abc123\\\\nanswer","responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                submitted, response, submit_s, response_s, transcript = (
                    MODULE.run_repl_consult(
                        "ignored",
                        submit_timeout=1,
                        response_timeout=1,
                    )
                )

        self.assertEqual(submitted["quality"], "pro")
        self.assertEqual(response["responseText"], "ID: abc123\nanswer")
        self.assertEqual(submit_s, 1.234)
        self.assertEqual(response_s, 5.678)
        self.assertIn("ASIDE_REPL_SUBMIT_RESULT", transcript)
        self.assertIn("ASIDE_REPL_RESPONSE_RESULT", transcript)

    def test_submission_runner_rejects_missing_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text("#!/bin/sh\nprintf 'no markers\\n'\n", encoding="utf-8")
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with self.assertRaisesRegex(RuntimeError, "before submission marker"):
                    MODULE.run_repl_consult(
                        "ignored",
                        submit_timeout=1,
                        response_timeout=1,
                    )

    def test_single_repl_preserves_committed_turn_on_response_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}')
print('response failed')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with self.assertRaisesRegex(
                    MODULE.SubmittedResponseError,
                    "do not resend",
                ) as raised:
                    MODULE.run_repl_consult(
                        "ignored",
                        submit_timeout=1,
                        response_timeout=1,
                    )
        self.assertEqual(raised.exception.submit_payload["targetId"], "target")

    def test_process_timeout_after_submit_is_committed_response_failure(self) -> None:
        timeout = __import__("subprocess").TimeoutExpired(
            cmd=["aside", "repl"],
            timeout=1,
            output=(
                'ASIDE_REPL_SUBMIT_RESULT {"quality":"pro",'
                '"submitElapsedMs":1234,'
                '"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1",'
                '"targetId":"target"}\n'
            ),
        )
        with mock.patch.object(MODULE.subprocess, "run", side_effect=timeout):
            with self.assertRaises(MODULE.SubmittedResponseError) as raised:
                MODULE.run_repl_consult(
                    "ignored",
                    submit_timeout=1,
                    response_timeout=1,
                )
        self.assertEqual(raised.exception.submit_payload["targetId"], "target")

    def test_submission_runner_classifies_submit_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_UNKNOWN {"quality":"pro","reason":"commit unverified"}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with self.assertRaisesRegex(
                    MODULE.SubmitUnknownError, "do not retry"
                ):
                    MODULE.run_repl_consult(
                        "ignored",
                        submit_timeout=1,
                        response_timeout=1,
                    )

    def test_main_returns_76_for_submit_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_UNKNOWN {"quality":"pro","reason":"commit unverified"}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                result = MODULE.main(
                    [
                        "--quality", "pro",
                        "--packet", str(packet),
                        "--url", "https://chatgpt.com/g/g-p-test-work/project",
                        "--response-output", str(root / "response.md"),
                        "--json-output", str(root / "result.json"),
                        "--stderr-output", str(root / "stderr.log"),
                    ]
                )

            self.assertEqual(result, 76)
            self.assertIn(
                "do not retry",
                (root / "stderr.log").read_text(encoding="utf-8"),
            )

    def test_main_returns_77_after_committed_turn_recovery_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"GPT-5.6 Sol","tier":"Pro (5 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}')
print("response phase failed")
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
            result_path = root / "result.json"
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                result = MODULE.main(
                    [
                        "--quality", "pro",
                        "--packet", str(packet),
                        "--url", "https://chatgpt.com/g/g-p-test-work/project",
                        "--response-output", str(root / "response.md"),
                        "--json-output", str(result_path),
                        "--stderr-output", str(root / "stderr.log"),
                    ]
                )

            self.assertEqual(result, 77)
            evidence = __import__("json").loads(result_path.read_text())
            self.assertEqual(evidence["status"], "submitted_response_unavailable")
            self.assertEqual(
                evidence["conversationUrl"],
                "https://chatgpt.com/g/g-p-test-work/c/1",
            )
            self.assertEqual(evidence["targetId"], "target")

    def test_main_returns_77_for_invalid_downloaded_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            artifact = root / "artifact.zip"
            temporary_artifact = root / "downloaded.zip"
            fake = root / "aside"
            fake.write_text(
                f"""#!/usr/bin/env python3
import pathlib
pathlib.Path({str(temporary_artifact)!r}).write_bytes(b"not a zip")
print('ASIDE_REPL_SUBMIT_RESULT {{"quality":"pro","model":"GPT-5.6 Sol","tier":"Pro (5 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}}')
print('ASIDE_REPL_RESPONSE_RESULT {{"responseText":"ID: placeholder","artifact":{{"temporaryPath":{json.dumps(str(temporary_artifact))},"suggestedFilename":"downloaded.zip"}},"responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
            result_path = root / "result.json"
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch("secrets.token_hex", return_value="placeholder"):
                    result = MODULE.main(
                        [
                            "--quality", "pro",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--artifact-output", str(artifact),
                            "--response-output", str(root / "response.md"),
                            "--json-output", str(result_path),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )

            self.assertEqual(result, 77)
            evidence = __import__("json").loads(result_path.read_text())
            self.assertEqual(evidence["status"], "submitted_artifact_unavailable")
            self.assertEqual(evidence["targetId"], "target")
            self.assertEqual(evidence["id"], "placeholder")
            self.assertEqual(evidence["topic"], "Test topic")


if __name__ == "__main__":
    unittest.main()
