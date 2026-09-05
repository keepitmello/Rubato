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
    / "run_aside_repl_outpost.py"
)
SPEC = importlib.util.spec_from_file_location("run_aside_repl_outpost_test", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AsideReplConsultTest(unittest.TestCase):
    def setUp(self) -> None:
        self._sessions_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._sessions_dir.cleanup)
        self._sessions_env = mock.patch.dict(
            os.environ,
            {"OUTPOST_SESSIONS_PATH": str(Path(self._sessions_dir.name) / "sessions.json")},
        )
        self._sessions_env.start()
        self.addCleanup(self._sessions_env.stop)

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
            config = Path(temp) / "outpost.env"
            config.write_text(
                "OUTPOST_PROJECT_NAME=Shopping\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("OUTPOST_PROJECT_NAME", None)
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
            outpost_id="abc123",
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
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        pro = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_base64="cGFja2V0",
            topic="병렬 세션 탭 소유권",
            outpost_id="abc123",
            response_timeout_ms=1000,
            artifact_output="/tmp/artifact.zip",
        )

        self.assertEqual(MODULE.SUBMIT_TIMEOUT_SECONDS, 120)
        self.assertIn("개 중", xhigh)
        self.assertIn("verifiedTier", xhigh)
        self.assertIn("5.6 Sol", xhigh)
        self.assertIn('var targetLabel = "매우 높음"', xhigh)
        self.assertIn('var targetLabel = "Pro"', pro)
        self.assertIn('data-tpp-toggle-value="chatgpt"', xhigh)
        self.assertIn('data-tpp-toggle-value="work"', xhigh)
        self.assertIn("Chat surface not selected", xhigh)
        self.assertIn("Work mode selected and Chat toggle missing", xhigh)
        self.assertIn("chatToggleVisible", xhigh)
        self.assertIn("ChatGPT rate-limited the project page", xhigh)
        self.assertIn("backend-api/conversation", xhigh)
        self.assertIn("readAssistantFromBackend", xhigh)
        self.assertIn("recoveredFromBackend", xhigh)
        self.assertIn("i < 80", xhigh)
        self.assertNotIn(
            "await snapshot(workPage, { interactive: true });\n    submitStage = 'wait-project-composer'",
            xhigh,
        )
        self.assertNotIn("var targetIndex = 4", xhigh)
        self.assertNotIn("/5개 중 ([1-5])번째/", xhigh)
        self.assertNotIn("Fast 모드 활성화", pro)
        self.assertNotIn("Work mode is selected", pro)
        self.assertIn("병렬 세션 탭 소유권\\nID: abc123", pro)
        self.assertNotIn("ID missing from assistant response", pro)
        self.assertIn("idMatched", pro)
        self.assertIn("packetUnread", pro)
        self.assertIn("assistant response text was empty", pro)
        self.assertLess(
            pro.index("ASIDE_REPL_RESPONSE_RESULT"),
            pro.index("closeTab(workPage)"),
        )
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
        self.assertIn("getByRole('group'", pro)
        self.assertIn("attachmentChip.waitFor", pro)
        self.assertNotIn("getByText(packetName, { exact: true })", pro)
        self.assertLess(pro.index("fill-composer"), pro.index("attach-packet"))
        self.assertIn("packet attachment missing before send", pro)
        self.assertNotIn("attachmentChip.isVisible()", pro)
        self.assertNotIn("assistant could not read the attached packet", pro)
        self.assertNotIn("Fast 모드 활성화", pro)
        self.assertNotIn("Fast mode still checked", pro)
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

    def test_main_returns_75_when_daemon_unreachable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(
                    MODULE,
                    "ensure_aside_daemon",
                    return_value="aside daemon is not reachable",
                ):
                    result = MODULE.main(
                        [
                            "--quality", "xhigh",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(root / "response.md"),
                            "--json-output", str(root / "result.json"),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
        self.assertEqual(result, 75)

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

    def test_repl_process_passes_script_as_argv(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
import sys
print(sys.argv[2])
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"xhigh","submitElapsedMs":1,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"t"}')
print('ASIDE_REPL_RESPONSE_RESULT {"responseText":"ok","responseElapsedMs":1,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                _submitted, _response, _submit_s, _response_s, transcript = (
                    MODULE.run_repl_outpost(
                        "UNIQUE_SCRIPT_BODY",
                        submit_timeout=1,
                        response_timeout=1,
                    )
                )
        self.assertIn("UNIQUE_SCRIPT_BODY", transcript)

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
                    MODULE.run_repl_outpost(
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

    def test_main_saves_reply_when_assistant_omits_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"xhigh","model":"GPT-5.6 Sol","tier":"매우 높음 (4 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}')
print('ASIDE_REPL_RESPONSE_RESULT {"responseText":"no id here","idMatched":false,"packetUnread":false,"responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
            response_path = root / "response.md"
            result_path = root / "result.json"
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    result = MODULE.main(
                        [
                            "--quality", "xhigh",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(response_path),
                            "--json-output", str(result_path),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
            self.assertEqual(result, 0)
            self.assertIn("no id here", response_path.read_text(encoding="utf-8"))
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertTrue(evidence["ok"])
            self.assertFalse(evidence["idMatched"])
            self.assertFalse(evidence["packetUnread"])

    def test_conversation_payload_helpers_and_backend_recovery_script(self) -> None:
        payload = {
            "mapping": {
                "u": {
                    "message": {
                        "author": {"role": "user"},
                        "content": {"parts": ["ID: abc123\nQ"]},
                        "create_time": 1,
                    }
                },
                "a": {
                    "message": {
                        "author": {"role": "assistant"},
                        "content": {"parts": ["hello"]},
                        "status": "finished_successfully",
                        "create_time": 2,
                    }
                },
            }
        }
        self.assertEqual(
            MODULE.conversation_id_from_url(
                "https://chatgpt.com/g/g-p-x/c/6a95625e-1f78-83e8-aa90-a49f982e36ef"
            ),
            "6a95625e-1f78-83e8-aa90-a49f982e36ef",
        )
        self.assertIsNone(
            MODULE.conversation_id_from_url(
                "https://chatgpt.com/g/g-p-x/project"
            )
        )
        extracted = MODULE.assistant_from_conversation_payload(payload)
        self.assertEqual(extracted["text"], "hello")
        self.assertTrue(extracted["finished"])
        self.assertTrue(MODULE.user_message_has_outpost_id(payload, "abc123"))
        script = MODULE.build_backend_recovery_script(
            "abc123",
            "https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
        )
        self.assertIn("openTab('https://chatgpt.com/')", script)
        self.assertIn("backend-api/conversation", script)
        self.assertIn("backend-api/conversations?offset=0&limit=15", script)
        self.assertNotIn("/project", script)
        self.assertIn("ASIDE_BACKEND_RECOVERY_RESULT", script)
        self.assertIn("pollIntervalMs", script)
        self.assertIn("Date.now() + 45000", script)
        long_script = MODULE.build_backend_recovery_script(
            "abc123",
            "https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
            timeout_ms=90000,
        )
        self.assertIn("Date.now() + 90000", long_script)

    def test_daemon_loss_recovers_from_backend_instead_of_resend(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text(
                "#!/bin/sh\nprintf 'fetch failed: other side closed\\nAside daemon is not reachable\\n'\n",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(
                    MODULE,
                    "recover_outpost_from_backend",
                    return_value={
                        "ok": True,
                        "responseText": "recovered",
                        "finished": True,
                        "idMatched": True,
                        "conversationUrl": "https://chatgpt.com/c/abc",
                    },
                ) as recover:
                    submitted, response, _submit_s, _response_s, _transcript = (
                        MODULE.run_repl_outpost(
                            "ignored",
                            submit_timeout=1,
                            response_timeout=1,
                            outpost_id="abc123",
                        )
                    )
        recover.assert_called_once_with("abc123")
        self.assertEqual(response["responseText"], "recovered")
        self.assertTrue(response["recoveredFromBackend"])
        self.assertEqual(submitted["conversationUrl"], "https://chatgpt.com/c/abc")

    def test_daemon_loss_before_submit_is_classified(self) -> None:
        self.assertTrue(
            MODULE.transcript_lost_aside_daemon(
                "fetch failed: other side closed\n"
                "Aside daemon is not reachable — make sure Aside Browser is running\n"
            )
        )
        self.assertFalse(MODULE.transcript_lost_aside_daemon("ASIDE_REPL_SUBMIT_RESULT {}\n"))
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text(
                "#!/bin/sh\nprintf 'Aside daemon is not reachable\\n'\n",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(
                    MODULE,
                    "ensure_aside_daemon",
                    return_value="aside daemon is not reachable",
                ):
                    with self.assertRaisesRegex(RuntimeError, "daemon closed before submission"):
                        MODULE.run_repl_outpost(
                            "ignored",
                            submit_timeout=1,
                            response_timeout=1,
                        )

    def test_daemon_loss_before_submit_retries_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            counter = root / "n"
            counter.write_text("0", encoding="utf-8")
            fake = root / "aside"
            fake.write_text(
                f"""#!/bin/sh
n=$(cat '{counter}')
n=$((n + 1))
printf '%s' "$n" > '{counter}'
if [ "$n" -eq 1 ]; then
  printf 'fetch failed: other side closed\\nAside daemon is not reachable\\n'
  exit 0
fi
printf '%s\\n' 'ASIDE_REPL_SUBMIT_RESULT {{"quality":"xhigh","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}}'
printf '%s\\n' 'ASIDE_REPL_RESPONSE_RESULT {{"responseText":"ok","responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}}'
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    submitted, response, _submit_s, _response_s, _transcript = (
                        MODULE.run_repl_outpost(
                            "ignored",
                            submit_timeout=1,
                            response_timeout=1,
                        )
                    )
        self.assertEqual(submitted["quality"], "xhigh")
        self.assertEqual(response["responseText"], "ok")

    def test_submission_runner_rejects_missing_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "aside"
            fake.write_text("#!/bin/sh\nprintf 'no markers\\n'\n", encoding="utf-8")
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with self.assertRaisesRegex(RuntimeError, "before submission marker"):
                    MODULE.run_repl_outpost(
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
                    MODULE.run_repl_outpost(
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
                MODULE.run_repl_outpost(
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
                    MODULE.run_repl_outpost(
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
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
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

    def test_main_recovers_backend_after_submitted_response_failure(self) -> None:
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
            response_path = root / "response.md"
            result_path = root / "result.json"
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    with mock.patch.object(
                        MODULE,
                        "recover_outpost_from_backend",
                        return_value={
                            "ok": True,
                            "responseText": "backend answer",
                            "finished": True,
                            "idMatched": True,
                            "conversationUrl": "https://chatgpt.com/c/1",
                        },
                    ):
                        result = MODULE.main(
                            [
                                "--quality", "pro",
                                "--packet", str(packet),
                                "--url", "https://chatgpt.com/g/g-p-test-work/project",
                                "--response-output", str(response_path),
                                "--json-output", str(result_path),
                                "--stderr-output", str(root / "stderr.log"),
                            ]
                        )
            self.assertEqual(result, 0)
            self.assertEqual(response_path.read_text(encoding="utf-8"), "backend answer\n")
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertTrue(evidence["ok"])
            self.assertTrue(evidence["recoveredFromBackend"])

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
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
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
                "https://chatgpt.com/c/1",
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
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
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

    def test_recover_from_saved_state_never_resends(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            evidence = root / "result.json"
            evidence.write_text(
                json.dumps(
                    {
                        "ok": False,
                        "status": "submitted_response_unavailable",
                        "id": "abc123",
                        "topic": "Test topic",
                        "quality": "pro",
                        "model": "GPT-5.6 Sol",
                        "tier": "Pro (5 of 5)",
                        "conversationUrl": "https://chatgpt.com/c/1",
                        "targetId": "target",
                        "packetPath": str(root / "packet.md"),
                    }
                ),
                encoding="utf-8",
            )
            response_path = root / "response.md"
            result_path = root / "recovered.json"
            with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                with mock.patch.object(
                    MODULE,
                    "recover_outpost_from_backend",
                    return_value={
                        "ok": True,
                        "responseText": "recovered later",
                        "finished": True,
                        "idMatched": True,
                        "conversationUrl": "https://chatgpt.com/c/1",
                    },
                ) as recover:
                    result = MODULE.main(
                        [
                            "--recover-from", str(evidence),
                            "--response-output", str(response_path),
                            "--json-output", str(result_path),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
            recover.assert_called_once()
            self.assertEqual(recover.call_args.args[0], "abc123")
            self.assertEqual(result, 0)
            self.assertEqual(response_path.read_text(encoding="utf-8"), "recovered later\n")
            saved = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertTrue(saved["ok"])
            self.assertTrue(saved["recoveredFromBackend"])
            self.assertEqual(saved["id"], "abc123")

    def test_list_and_thread_flags_are_parseable(self) -> None:
        listed = MODULE.parse_args(["--list"])
        self.assertTrue(listed.list)
        continued = MODULE.parse_args(
            ["--thread", "abcd1234", "--quality", "xhigh", "--packet", "p"]
        )
        self.assertEqual(continued.thread, "abcd1234")
        self.assertEqual(continued.quality, "xhigh")
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["--list", "--quality", "xhigh", "--packet", "p"])
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["--thread", "abcd1234"])
        with self.assertRaises(SystemExit):
            MODULE.parse_args(
                [
                    "--thread", "abcd",
                    "--conversation-url", "https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
                    "--quality", "xhigh",
                    "--packet", "p",
                ]
            )
        with self.assertRaises(SystemExit):
            MODULE.parse_args(
                [
                    "--conversation-url", "https://chatgpt.com/g/g-p-x/project",
                    "--quality", "xhigh",
                    "--packet", "p",
                ]
            )

    def test_follow_up_prompt_keeps_prior_conversation(self) -> None:
        follow = MODULE.build_composer_prompt(
            "후속 질문",
            "abc123",
            None,
            follow_up=True,
        )
        self.assertTrue(follow.startswith("후속 질문\nID: abc123\n\n"))
        self.assertIn("같은 대화의 후속 질문", follow)
        self.assertNotIn("이전 대화는 볼 수 없다고 가정", follow)

    def test_continue_script_opens_saved_conversation_not_project_home(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="xhigh",
            packet_name="packet.md",
            packet_base64="cGFja2V0",
            topic="후속",
            outpost_id="abc123",
            response_timeout_ms=1000,
            conversation_url="https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
            follow_up=True,
        )
        self.assertIn("var continueMode = true", script)
        self.assertIn("wait-conversation-composer", script)
        self.assertIn("6a95625e-1f78-83e8-aa90-a49f982e36ef", script)
        self.assertIn("continue landed off the saved conversation", script)
        self.assertIn("saved conversation composer not visible", script)
        self.assertIn("> assistantCountBefore", script)
        self.assertIn("outpostId", script)
        self.assertIn("같은 대화의 후속 질문", script)

    def test_assistant_helper_ignores_previous_turn(self) -> None:
        payload = {
            "mapping": {
                "old-user": {
                    "message": {
                        "author": {"role": "user"},
                        "content": {"parts": ["ID: old\nQ1"]},
                        "create_time": 1,
                    },
                    "children": ["old-assistant"],
                },
                "old-assistant": {
                    "message": {
                        "author": {"role": "assistant"},
                        "content": {"parts": ["previous answer"]},
                        "status": "finished_successfully",
                        "create_time": 2,
                    }
                },
                "new-user": {
                    "message": {
                        "author": {"role": "user"},
                        "content": {"parts": ["ID: abc123\nQ2"]},
                        "create_time": 3,
                    },
                    "children": ["new-assistant"],
                },
                "new-assistant": {
                    "message": {
                        "author": {"role": "assistant"},
                        "content": {"parts": ["follow-up answer"]},
                        "status": "finished_successfully",
                        "create_time": 4,
                    }
                },
            }
        }
        extracted = MODULE.assistant_from_conversation_payload(payload, "abc123")
        self.assertEqual(extracted["text"], "follow-up answer")
        self.assertEqual(
            MODULE.assistant_from_conversation_payload(payload)["text"],
            "follow-up answer",
        )
        pending = MODULE.assistant_from_conversation_payload(
            {
                "mapping": {
                    "old-assistant": payload["mapping"]["old-assistant"],
                    "new-user": payload["mapping"]["new-user"],
                }
            },
            "abc123",
        )
        self.assertEqual(pending["text"], "")
        self.assertFalse(pending["finished"])

    def test_main_lists_threads_without_aside(self) -> None:
        store = MODULE.SESSIONS.SessionStore(
            Path(os.environ["OUTPOST_SESSIONS_PATH"])
        )
        store.create_thread(
            topic="목록 테스트",
            quality="xhigh",
            project_name="Work",
            outpost_id="turn-1",
            pid=os.getpid(),
        )
        with mock.patch.object(MODULE.shutil, "which", return_value=None):
            result = MODULE.main(["--list"])
        self.assertEqual(result, 0)

    def test_main_records_new_thread_and_continues_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"xhigh","model":"GPT-5.6 Sol","tier":"매우 높음 (4 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef","targetId":"target"}')
print('ASIDE_REPL_RESPONSE_RESULT {"responseText":"answer","idMatched":false,"packetUnread":false,"responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef"}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# 세션 유지\n\nquestion", encoding="utf-8")
            first_result = root / "first.json"
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    first = MODULE.main(
                        [
                            "--quality", "xhigh",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(root / "first.md"),
                            "--json-output", str(first_result),
                            "--stderr-output", str(root / "first.log"),
                        ]
                    )
                    evidence = json.loads(first_result.read_text(encoding="utf-8"))
                    second = MODULE.main(
                        [
                            "--thread", evidence["threadId"],
                            "--quality", "xhigh",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(root / "second.md"),
                            "--json-output", str(root / "second.json"),
                            "--stderr-output", str(root / "second.log"),
                        ]
                    )
            self.assertEqual(first, 0)
            self.assertEqual(second, 0)
            store = MODULE.SESSIONS.SessionStore(Path(os.environ["OUTPOST_SESSIONS_PATH"]))
            thread = store.resolve(evidence["threadId"])
            self.assertEqual(thread["status"], "finished")
            self.assertEqual(len(thread["turns"]), 2)
            self.assertEqual(thread["turns"][0]["mode"], "new")
            self.assertEqual(thread["turns"][1]["mode"], "continue")
            self.assertEqual(
                thread["conversationId"],
                "6a95625e-1f78-83e8-aa90-a49f982e36ef",
            )
            follow = json.loads((root / "second.json").read_text(encoding="utf-8"))
            self.assertEqual(follow["threadId"], evidence["threadId"])
            self.assertEqual(follow["mode"], "continue")

    def test_main_rejects_unknown_thread_before_send(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# 없는 스레드\n\nquestion", encoding="utf-8")
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    result = MODULE.main(
                        [
                            "--thread", "missing",
                            "--quality", "xhigh",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(root / "response.md"),
                            "--json-output", str(root / "result.json"),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
        self.assertEqual(result, 2)

    def test_main_keeps_submit_conversation_when_response_is_project_home(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text(
                """#!/usr/bin/env python3
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"xhigh","model":"GPT-5.6 Sol","tier":"매우 높음 (4 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/6a99ef53-3d80-83ee-a84c-187e4a415929","targetId":"target"}')
print('ASIDE_REPL_RESPONSE_RESULT {"responseText":"answer","idMatched":true,"packetUnread":false,"responseElapsedMs":25,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/project"}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Outpost 경로 확인\n\nquestion", encoding="utf-8")
            result_path = root / "result.json"
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    result = MODULE.main(
                        [
                            "--quality", "xhigh",
                            "--packet", str(packet),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(root / "response.md"),
                            "--json-output", str(result_path),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
            self.assertEqual(result, 0)
            evidence = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual(
                evidence["conversationUrl"],
                "https://chatgpt.com/c/6a99ef53-3d80-83ee-a84c-187e4a415929",
            )
            store = MODULE.SESSIONS.SessionStore(Path(os.environ["OUTPOST_SESSIONS_PATH"]))
            thread = store.resolve(evidence["threadId"])
            self.assertEqual(
                thread["conversationUrl"],
                "https://chatgpt.com/c/6a99ef53-3d80-83ee-a84c-187e4a415929",
            )
            continued = MODULE.open_or_continue_thread(
                MODULE.parse_args([
                    "--thread", evidence["threadId"],
                    "--quality", "xhigh",
                    "--packet", str(packet),
                    "--url", "https://chatgpt.com/g/g-p-test-work/project",
                    "--response-output", str(root / "c.md"),
                    "--json-output", str(root / "c.json"),
                    "--stderr-output", str(root / "c.log"),
                ]),
                topic="Outpost 경로 확인",
                quality="xhigh",
                project_name="Work",
                outpost_id="follow",
                packet_path=str(packet),
            )
            self.assertEqual(
                continued[4],
                "https://chatgpt.com/c/6a99ef53-3d80-83ee-a84c-187e4a415929",
            )
            self.assertTrue(continued[5])

    def test_open_or_continue_uses_conversation_id_when_url_is_project_home(self) -> None:
        store = MODULE.SESSIONS.SessionStore(Path(os.environ["OUTPOST_SESSIONS_PATH"]))
        thread = store.create_thread(
            topic="복구",
            quality="xhigh",
            project_name="Work",
            outpost_id="turn-1",
        )
        raw = store.read()
        for item in raw["threads"]:
            if item["threadId"] == thread["threadId"]:
                item["conversationId"] = "6a99ef53-3d80-83ee-a84c-187e4a415929"
                item["conversationUrl"] = "https://chatgpt.com/g/g-p-x-work/project"
                item["status"] = "finished"
                item["pid"] = None
        store.write(raw)
        packet = Path(self._sessions_dir.name) / "packet.md"
        packet.write_text("# 복구\n\nq", encoding="utf-8")
        _store, _thread, _lock, needs_start, conversation_url, follow_up = MODULE.open_or_continue_thread(
            MODULE.parse_args([
                "--thread", thread["threadId"],
                "--quality", "xhigh",
                "--packet", str(packet),
                "--url", "https://chatgpt.com/g/g-p-test-work/project",
                "--response-output", str(packet.with_name("r.md")),
                "--json-output", str(packet.with_name("r.json")),
                "--stderr-output", str(packet.with_name("r.log")),
            ]),
            topic="복구",
            quality="xhigh",
            project_name="Work",
            outpost_id="turn-2",
            packet_path=str(packet),
        )
        self.assertTrue(needs_start)
        self.assertTrue(follow_up)
        self.assertEqual(
            conversation_url,
            "https://chatgpt.com/c/6a99ef53-3d80-83ee-a84c-187e4a415929",
        )

    def test_repl_script_keeps_sticky_conversation_url(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="xhigh",
            packet_name="outpost-x.md",
            packet_base64="Zg==",
            topic="t",
            outpost_id="x",
            response_timeout_ms=1000,
        )
        self.assertIn("function conversationUrlFrom", script)
        self.assertIn("stickyConversationUrl", script)
        self.assertIn("conversationUrlFrom(workPage.url()) || stickyConversationUrl", script)



    def test_assistant_from_conversation_payload_ignores_thinking_preamble(self) -> None:
        payload = {
            "current_node": "node-real",
            "mapping": {
                "node-user": {
                    "message": {
                        "author": {"role": "user"},
                        "content": {"parts": ["ID: out-123\nhello"]},
                        "create_time": 100.0,
                    },
                    "children": ["node-preamble"],
                },
                "node-preamble": {
                    "message": {
                        "author": {"role": "assistant"},
                        "content": {"parts": ["패킷을 확인했습니다."]},
                        "status": "finished_successfully",
                        "end_turn": True,
                        "create_time": 101.0,
                        "metadata": {"is_thinking_preamble_message": True},
                    },
                    "children": ["node-tool"],
                },
                "node-tool": {
                    "message": {
                        "author": {"role": "tool"},
                        "content": {"parts": []},
                        "status": "finished_successfully",
                        "create_time": 102.0,
                    },
                    "children": ["node-real"],
                },
                "node-real": {
                    "message": {
                        "author": {"role": "assistant"},
                        "content": {"parts": ["최종 답변 전체 내용입니다."]},
                        "status": "finished_successfully",
                        "end_turn": True,
                        "create_time": 103.0,
                        "metadata": {"is_complete": True},
                    },
                    "children": [],
                },
            },
        }
        res = MODULE.assistant_from_conversation_payload(payload, outpost_id="out-123")
        self.assertTrue(res["finished"])
        self.assertEqual(res["text"], "최종 답변 전체 내용입니다.")

        # Test when only preamble exists and in progress
        payload_in_progress = {
            "current_node": "node-preamble",
            "mapping": {
                "node-user": {
                    "message": {
                        "author": {"role": "user"},
                        "content": {"parts": ["ID: out-123\nhello"]},
                        "create_time": 100.0,
                    },
                    "children": ["node-preamble"],
                },
                "node-preamble": {
                    "message": {
                        "author": {"role": "assistant"},
                        "content": {"parts": ["패킷을 확인했습니다."]},
                        "status": "finished_successfully",
                        "end_turn": True,
                        "create_time": 101.0,
                        "metadata": {"is_thinking_preamble_message": True},
                    },
                    "children": ["node-tool"],
                },
                "node-tool": {
                    "message": {
                        "author": {"role": "tool"},
                        "content": {"parts": []},
                        "status": "in_progress",
                        "create_time": 102.0,
                    },
                    "children": [],
                },
            },
        }
        res2 = MODULE.assistant_from_conversation_payload(payload_in_progress, outpost_id="out-123")
        self.assertFalse(res2["finished"])

    def test_save_outpost_attachments_and_format(self) -> None:
        import base64
        import shutil
        outpost_id = "test-unit-attach-999"
        dl = [
            {"suggestedFilename": "data.csv", "contentBase64": base64.b64encode(b"a,b\n1,2").decode("ascii")},
        ]
        wa = [
            {"title": "Note Doc", "content": "# Note"},
        ]
        try:
            saved = MODULE.save_outpost_attachments(outpost_id, dl, wa)
            self.assertEqual(len(saved), 2)
            self.assertTrue(all(p.is_file() for p in saved))
            formatted = MODULE.format_attachments_section(saved)
            self.assertIn("첨부파일 (/tmp 저장됨)", formatted)
            self.assertIn("data.csv", formatted)
            self.assertIn("Note_Doc.md", formatted)
        finally:
            shutil.rmtree(f"/tmp/outpost-{outpost_id}", ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
