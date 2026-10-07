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
            {
                "OUTPOST_SESSIONS_PATH": str(Path(self._sessions_dir.name) / "sessions.json"),
                "OUTPOST_ASIDE_ROOT": str(Path(self._sessions_dir.name) / "aside"),
                # A test never reads the machine's learned screen map or calls
                # the heal model unless it asks to.
                "OUTPOST_UI_MAP_PATH": str(Path(self._sessions_dir.name) / "outpost-ui.json"),
                "OUTPOST_AUTO_HEAL": "0",
            },
        )
        self._sessions_env.start()
        self.addCleanup(self._sessions_env.stop)

    def test_the_rehearsal_walks_the_send_path_and_stops_before_the_click(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="outpost-abc.md",
            packet_path="/tmp/packet.md",
            topic="리허설",
            outpost_id="abc",
            response_timeout_ms=1000,
            dry_run=True,
        )
        self.assertIn("var dryRun = true;", script)
        self.assertIn("OUTPOST_REHEARSAL_RESULT", script)
        self.assertIn("OUTPOST_REHEARSAL_STOP", script)
        # The rehearsal ends before the click, so it can never spend a turn.
        self.assertLess(
            script.index("OUTPOST_REHEARSAL_RESULT"),
            script.index("submitState.send.click"),
        )
        # The pre-submit promise hands the composer over so the rehearsal can put
        # the project draft back before it closes the tab.
        self.assertIn("assistantCountBefore, composer }", script)
        # A top-level `return` makes the REPL drop the whole script silently.
        self.assertNotIn("\n  return;\n", script)

    def test_send_and_recovery_pin_the_workspace_that_holds_the_project(self) -> None:
        # After a browser restart ChatGPT can fall back to a workspace without the
        # project; sending or recovering there reads every project turn as 404.
        send = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project",
            quality="xhigh",
            packet_name="outpost-abc.md",
            packet_path="/tmp/packet.md",
            topic="계정",
            outpost_id="abc",
            response_timeout_ms=1000,
        )
        self.assertIn("var projectGizmoId = \"g-p-0123456789abcdef0123456789abcdef\";", send)
        pin = send.index("ensureProjectAccount(workPage, projectGizmoId)")
        self.assertLess(pin, send.index("submitStage = 'wait-project-composer'"))
        self.assertLess(pin, send.index("submitState.send.click"))
        recovery = MODULE.build_backend_recovery_script(
            "abc", None, project_url="https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project"
        )
        self.assertLess(
            recovery.index("await ensureProjectAccount(home, projectGizmoId)"),
            recovery.index("var sess = await"),
        )
        # A wrong workspace is not a screen change for the heal model, and a stop
        # there is before the prompt is typed, so nothing was sent.
        self.assertNotIn("select-account", MODULE.HEALABLE_STAGES)
        self.assertLess(
            MODULE.STAGE_ORDER.index("select-account"), MODULE.STAGE_ORDER.index("fill-composer")
        )

    def test_waiting_for_a_long_reply_never_holds_one_repl_past_asides_cut(self) -> None:
        # Aside drops a script's output at 120 s and keeps it polling in the
        # daemon; stacked pollers rate-limited the account (2026-10-01).
        now = [0.0]
        lookups = []

        def lookup(*args, **kwargs):
            lookups.append(kwargs["timeout"])
            now[0] += min(kwargs["timeout"], MODULE.REPL_LOOKUP_SECONDS)
            done = len(lookups) == 3
            return {"ok": True, "responseText": "answer" if done else "", "finished": done}

        def sleep(seconds):
            now[0] += seconds

        with mock.patch.object(MODULE, "run_repl_process") as repl, mock.patch.object(
            MODULE, "backend_lookup", side_effect=lookup
        ):
            payload = MODULE.recover_outpost_from_backend(
                "abc", "https://chatgpt.com/c/1", timeout=3600, clock=lambda: now[0], sleep=sleep
            )
        self.assertEqual(payload["responseText"], "answer")
        self.assertEqual(len(lookups), 3)
        repl.assert_not_called()
        with mock.patch.object(MODULE, "run_repl_process", return_value="") as repl:
            MODULE.backend_lookup("abc", "https://chatgpt.com/c/1", timeout=3600)
        self.assertLess(repl.call_args.kwargs["timeout"], 120)
        self.assertIn("Date.now() + 90000", repl.call_args.args[0])

    def test_a_later_result_write_keeps_the_project_the_turn_went_to(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "result.json"
            MODULE.write_result(path, {"status": "submitted_pending", "projectUrl": "https://chatgpt.com/g/g-p-ab/project", "startedAt": 5})
            MODULE.write_result(path, {"status": "submitted_response_unavailable", "conversationUrl": "https://chatgpt.com/c/1"})
            saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(saved["status"], "submitted_response_unavailable")
        self.assertEqual(saved["projectUrl"], "https://chatgpt.com/g/g-p-ab/project")
        self.assertEqual(saved["startedAt"], 5)

    def test_a_real_send_is_not_a_rehearsal(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="outpost-abc.md",
            packet_path="/tmp/packet.md",
            topic="진짜 전송",
            outpost_id="abc",
            response_timeout_ms=1000,
        )
        self.assertIn("var dryRun = false;", script)

    def test_quality_flag_is_required_and_limited(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.parse_args([])
        self.assertEqual(MODULE.parse_args(["--quality", "pro", "--packet", "p"]).quality, "pro")
        self.assertEqual(
            MODULE.parse_args(["--quality", "xhigh", "--packet", "p"]).quality, "xhigh"
        )
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
        self.assertEqual(
            MODULE.composer_aria_labels("Shopping"),
            ["Shopping의 새 채팅", "Shopping에서 새 채팅"],
        )
        shopping = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-shopping/project",
            project_name="Shopping",
            quality="pro",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
            topic="프로젝트 전환",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        self.assertIn(
            MODULE.js(MODULE.composer_selector(MODULE.composer_aria_labels("Shopping"))),
            shopping,
        )
        self.assertNotIn(".and(", shopping)
        self.assertIn("Shopping의 새 채팅", shopping)
        self.assertNotIn("Work의 새 채팅", shopping)
        self.assertNotIn("Work에서 새 채팅", shopping)
        self.assertIn("project composer not visible", shopping)

    def test_generated_script_has_quality_mapping_and_hard_deadline(self) -> None:
        pro = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
            topic="병렬 세션 탭 소유권",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        pro = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="pro",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
            topic="병렬 세션 탭 소유권",
            outpost_id="abc123",
            response_timeout_ms=1000,
            artifact_output="/tmp/artifact.zip",
        )

        self.assertEqual(MODULE.SUBMIT_TIMEOUT_SECONDS, 120)
        self.assertIn("개 중", pro)
        self.assertIn("verifiedTier", pro)
        self.assertIn(
            f'var targetModel = {json.dumps(MODULE.UI.DEFAULT_UI_MAP["modelRadio"])};',
            pro,
        )
        self.assertIn("targetModel", pro)
        self.assertIn('var targetLabels = ["Pro"]', pro)
        xhigh = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="xhigh",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
            topic="t",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        # ChatGPT has named the xhigh stop in both languages; either verifies it.
        self.assertIn('var targetLabels = ["Extra High", "매우 높음"]', xhigh)
        self.assertNotIn('"Pro"]', xhigh.split("var targetLabels = ")[1].split("\n")[0])
        self.assertIn("[0-9]* ?Pro", pro)
        self.assertIn("tier button not visible", pro)
        self.assertNotIn("매우 높음|Pro)$", pro)
        self.assertIn("OUTPOST_FAIL stage=", pro)
        self.assertIn("OUTPOST_FAIL stage=' + submitStage", pro)
        self.assertIn("Chat surface not selected", pro)
        self.assertIn("Work mode selected and Chat toggle missing", pro)
        self.assertIn("chatToggleVisible", pro)
        self.assertIn("ChatGPT rate-limited the project page", pro)
        self.assertIn("backend-api/conversation", pro)
        self.assertIn("readAssistantFromBackend", pro)
        self.assertIn("recoveredFromBackend", pro)
        self.assertIn("i < 80", pro)
        self.assertNotIn(
            "await snapshot(workPage, { interactive: true });\n    submitStage = 'wait-project-composer'",
            pro,
        )
        self.assertNotIn("var targetIndex = 4", pro)
        self.assertNotIn("/5개 중 ([1-5])번째/", pro)
        self.assertNotIn("Fast 모드 활성화", pro)
        self.assertNotIn("Work mode is selected", pro)
        self.assertIn("병렬 세션 탭 소유권\\nID: abc123", pro)
        self.assertNotIn("ID missing from assistant response", pro)
        self.assertIn("idMatched", pro)
        self.assertIn("packetUnread", pro)
        self.assertIn("assistant response text was empty", pro)
        # The reply is saved before the real send path closes the tab. The
        # rehearsal branch closes its own tab earlier and never reaches a reply.
        self.assertLess(
            pro.index("ASIDE_REPL_RESPONSE_RESULT"),
            pro.rindex("closeTab(workPage)"),
        )
        self.assertIn("OUTPOST_REHEARSAL_RESULT", pro)
        self.assertIn("var dryRun = false", pro)
        self.assertIn("pre-submit preparation exceeded 110 seconds", pro)
        self.assertIn("user turn committed after 120-second deadline", pro)
        self.assertIn("submitElapsedMs >= 120000", pro)
        self.assertIn("Promise.race", pro)
        self.assertIn("pre-submit preparation exceeded 110 seconds", pro)
        self.assertIn("ASIDE_REPL_SUBMIT_UNKNOWN", pro)
        self.assertIn("ASIDE_REPL_SUBMIT_RESULT", pro)
        # Aside's click resolves the button once and never waits, so the
        # enabled send button is awaited first and a throwing click is kept,
        # not taken as proof that nothing was sent.
        self.assertLess(pro.index("submitState.send.waitFor("), pro.index("submitState.send.click("))
        self.assertIn("clickError = String(error", pro)
        self.assertIn("OUTPOST_FAIL stage=commit-user-turn send click failed", pro)
        self.assertIn("ASIDE_REPL_RESPONSE_RESULT", pro)
        # The bytes are read from staged files, never inlined into the script.
        self.assertIn("await fs.readFile(packetFile)", pro)
        self.assertNotIn("base64", pro.split("var extraUploads")[0].split("var packetFile")[1])
        self.assertIn("name: packetName", pro)
        self.assertIn("setInputFiles(uploadFiles)", pro)
        self.assertNotIn("setInputFiles(packetPath)", pro)
        self.assertNotIn(".and(", pro)
        self.assertIn("Work의 새 채팅", pro)
        self.assertIn("project composer not visible", pro)
        self.assertIn("composer.press('Meta+A')", pro)
        self.assertIn("composer.press('Backspace')", pro)
        self.assertIn("keyboard.insertText(composerPrompt)", pro)
        self.assertIn("Array.from(el.children)", pro)
        self.assertIn("composerValue !== composerPrompt", pro)
        # send waits for an enabled button, whichever selector the map gives it
        send_line = next(line for line in pro.splitlines() if line.startswith("var sendSelector = "))
        send_selector = json.loads(send_line[len("var sendSelector = "):].rstrip(";"))
        for part in send_selector.split(", "):
            self.assertTrue(part.endswith(':not([data-visually-disabled])'), part)
        self.assertIn("waitRole(workPage, 'group'", pro)
        self.assertIn("attachmentPresent(", pro)
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

    def test_pre_submit_failure_names_the_stage(self) -> None:
        text = MODULE.describe_pre_submit_failure(
            "Aside REPL exited before submission marker\n"
            "OUTPOST_FAIL stage=select-tier tier button not visible: []\n"
        )
        self.assertIn("exit 75", text)
        self.assertIn("단계: select-tier (추론 수준/Pro 버튼)", text)
        self.assertIn("tier button not visible", text)

    def test_doctor_flag_does_not_need_packet(self) -> None:
        args = MODULE.parse_args(["--doctor"])
        self.assertTrue(args.doctor)

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
                        "--quality", "pro",
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
                            "--quality", "pro",
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
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","submitElapsedMs":1,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"t"}')
print('ASIDE_REPL_RESPONSE_RESULT {"modelSlug":"gpt-6-pro","responseText":"ok","responseElapsedMs":1,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}')
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
print('ASIDE_REPL_RESPONSE_RESULT {"modelSlug":"gpt-6-pro","responseText":"ID: abc123\\\\nanswer","responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}')
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
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"GPT-6","tier":"매우 높음 (4 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}')
print('ASIDE_REPL_RESPONSE_RESULT {"modelSlug":"gpt-6-pro","responseText":"no id here","idMatched":false,"packetUnread":false,"responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}')
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
                            "--quality", "pro",
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
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None), mock.patch.object(
                    MODULE,
                    "locate_outpost_turn",
                    return_value=("found", {
                        "ok": True,
                        "found": True,
                        "responseText": "recovered", "modelSlug": "gpt-6-pro",
                        "finished": True,
                        "idMatched": True,
                        "conversationUrl": "https://chatgpt.com/c/abc",
                    }),
                ) as locate:
                    submitted, response, _submit_s, _response_s, _transcript = (
                        MODULE.run_repl_outpost(
                            "ignored",
                            submit_timeout=1,
                            response_timeout=1,
                            outpost_id="abc123",
                            project_url="https://chatgpt.com/g/g-p-abc123/project",
                        )
                    )
        self.assertEqual(locate.call_args.args[0], "abc123")
        self.assertEqual(locate.call_args.kwargs["project_url"], "https://chatgpt.com/g/g-p-abc123/project")
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
                ), mock.patch.object(
                    MODULE, "locate_outpost_turn", return_value=("absent", {"searched": True})
                ):
                    with self.assertRaisesRegex(RuntimeError, "daemon closed before submission"):
                        MODULE.run_repl_outpost(
                            "ignored",
                            submit_timeout=1,
                            response_timeout=1,
                            outpost_id="abc123",
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
printf '%s\\n' 'ASIDE_REPL_SUBMIT_RESULT {{"quality":"pro","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}}'
printf '%s\\n' 'ASIDE_REPL_RESPONSE_RESULT {{"modelSlug":"gpt-6-pro","responseText":"ok","responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}}'
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None), mock.patch.object(
                    MODULE, "locate_outpost_turn", return_value=("absent", {"searched": True})
                ):
                    submitted, response, _submit_s, _response_s, _transcript = (
                        MODULE.run_repl_outpost(
                            "ignored",
                            submit_timeout=1,
                            response_timeout=1,
                            outpost_id="abc123",
                        )
                    )
        self.assertEqual(submitted["quality"], "pro")
        self.assertEqual(response["responseText"], "ok")

    # The 2026-09-29 incident: the send click threw "not found" after the turn
    # had gone out, and the run reported "nothing was sent" (exit 75).
    INCIDENT_TRANSCRIPT = (
        "Error: Selector \"#composer-submit-button:not(:disabled), "
        "form button[type=\\\"submit\\\"][aria-label=\\\"보내기\\\"]:nth(0)\" not found\n"
        "    at async Cn.click (file:///aside-daemon:3204:1903)\n"
        "[error | 36364ms]\n"
    )

    def _fake_aside(self, root: Path, transcript: str) -> str:
        fake = root / "aside"
        fake.write_text(
            "#!/usr/bin/env python3\nimport sys\nsys.stdout.write(" + repr(transcript) + ")\n",
            encoding="utf-8",
        )
        fake.chmod(0o755)
        return f"{root}{os.pathsep}{os.environ.get('PATH', '')}"

    def _send(self, root: Path, path: str, **patches) -> tuple[int, dict, str]:
        packet = root / "packet.md"
        packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
        result_path = root / "result.json"
        stack = [mock.patch.dict(os.environ, {"PATH": path}), mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None)]
        stack += [mock.patch.object(MODULE, name, **kwargs) for name, kwargs in patches.items()]
        for item in stack:
            item.start()
        try:
            code = MODULE.main(
                [
                    "--quality", "xhigh",
                    "--packet", str(packet),
                    "--url", "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project",
                    "--project", "커리어",
                    "--response-output", str(root / "response.md"),
                    "--json-output", str(result_path),
                    "--stderr-output", str(root / "stderr.log"),
                ]
            )
        finally:
            for item in reversed(stack):
                item.stop()
        return code, json.loads(result_path.read_text(encoding="utf-8")), (root / "stderr.log").read_text(encoding="utf-8")

    def test_a_click_error_after_the_turn_went_out_is_a_sent_turn(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result, _ = self._send(
                root,
                self._fake_aside(root, self.INCIDENT_TRANSCRIPT),
                locate_outpost_turn={"return_value": ("found", {
                    "ok": True, "found": True, "searched": True,
                    "responseText": "ID answer", "finished": True, "idMatched": True,
                    "conversationUrl": "https://chatgpt.com/c/6abb5830-166c-83ee-86ca-c9d7f028e4b5",
                    "conversationId": "6abb5830-166c-83ee-86ca-c9d7f028e4b5",
                    "modelSlug": MODULE.required_model_slug("xhigh"),
                })},
            )
            self.assertEqual(code, 0)
            self.assertTrue(result["ok"])
            self.assertNotEqual(result.get("status"), "not_sent")
            self.assertEqual(result["conversationId"], "6abb5830-166c-83ee-86ca-c9d7f028e4b5")
            self.assertEqual((root / "response.md").read_text(encoding="utf-8"), "ID answer\n")

    def test_a_found_turn_still_answering_is_waited_for_not_resent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result, _ = self._send(
                root,
                self._fake_aside(root, self.INCIDENT_TRANSCRIPT),
                locate_outpost_turn={"return_value": ("found", {
                    "ok": True, "found": True, "searched": True, "responseText": "", "finished": False,
                    "conversationUrl": "https://chatgpt.com/c/6abb59f2-359c-83e8-93aa-c7c3f8af054f",
                })},
                recover_outpost_from_backend={"return_value": {
                    "ok": True, "responseText": "later answer", "finished": True, "idMatched": True,
                    "conversationUrl": "https://chatgpt.com/c/6abb59f2-359c-83e8-93aa-c7c3f8af054f",
                    "modelSlug": MODULE.required_model_slug("xhigh"),
                }},
            )
            self.assertEqual(code, 0)
            self.assertTrue(result["ok"])
            self.assertEqual(result["conversationUrl"], "https://chatgpt.com/c/6abb59f2-359c-83e8-93aa-c7c3f8af054f")

    def test_a_click_error_with_no_turn_anywhere_in_the_project_is_not_sent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code, result, stderr = self._send(
                root,
                self._fake_aside(root, "Error: OUTPOST_FAIL stage=commit-user-turn send click failed and no user turn showed on the page\n"),
                locate_outpost_turn={"return_value": ("absent", {"ok": False, "found": False, "searched": True})},
            )
            self.assertEqual(code, 75)
            self.assertEqual(result["status"], "not_sent")
            self.assertIn("no turn with this id in the project", stderr)

    def test_an_unprovable_send_is_unknown_and_blocks_a_resend(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = self._fake_aside(root, self.INCIDENT_TRANSCRIPT)
            code, result, stderr = self._send(
                root, path, locate_outpost_turn={"return_value": ("unknown", None)}
            )
            self.assertEqual(code, 76)
            self.assertEqual(result["status"], "submit_unknown")
            self.assertEqual(result["projectUrl"], "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project")
            self.assertIn("do not retry", stderr)
            again, _, _ = self._send(root, path, locate_outpost_turn={"return_value": ("unknown", None)})
            self.assertEqual(again, MODULE.DUPLICATE_SEND_EXIT)

    def test_a_failure_before_the_prompt_is_typed_needs_no_backend_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            locate = mock.MagicMock(return_value=("unknown", None))
            code, result, _ = self._send(
                root,
                self._fake_aside(root, "Error: OUTPOST_FAIL stage=select-tier tier button not visible\n"),
                locate_outpost_turn={"new": locate},
            )
            self.assertEqual(code, 75)
            self.assertEqual(result["status"], "not_sent")
            locate.assert_not_called()

    def test_a_markerless_exit_is_never_called_unsent_without_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = self._fake_aside(Path(temp), "no markers\n")
            with mock.patch.dict(os.environ, {"PATH": path}):
                # No id to look up: nothing proves the packet stayed home.
                with self.assertRaisesRegex(MODULE.SubmitUnknownError, "do not retry"):
                    MODULE.run_repl_outpost("ignored", submit_timeout=1, response_timeout=1)
                with mock.patch.object(
                    MODULE, "locate_outpost_turn", return_value=("absent", {"searched": True})
                ):
                    with self.assertRaisesRegex(RuntimeError, "before submission marker") as raised:
                        MODULE.run_repl_outpost(
                            "ignored", submit_timeout=1, response_timeout=1, outpost_id="abc123"
                        )
                    self.assertNotIsInstance(raised.exception, MODULE.SubmitUnknownError)

    def test_the_backend_lookup_searches_the_project_and_knows_when_it_is_complete(self) -> None:
        self.assertEqual(
            MODULE.project_gizmo_id("https://chatgpt.com/g/g-p-6817528b20f4819199f283406b4fa74c-work/project"),
            "g-p-6817528b20f4819199f283406b4fa74c",
        )
        self.assertEqual(MODULE.project_gizmo_id(None), "")
        script = MODULE.build_backend_recovery_script(
            "abc123",
            None,
            project_url="https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project",
            since=1790662000,
            until_found=True,
        )
        # Project conversations are missing from the account-wide list.
        self.assertIn("/backend-api/gizmos/' + projectGizmoId + '/conversations", script)
        self.assertIn('var projectGizmoId = "g-p-0123456789abcdef0123456789abcdef";', script)
        self.assertIn("var untilFound = true;", script)
        self.assertIn("searched: searched", script)
        # A list with more pages only covers the send once it reaches past its start.
        self.assertIn("!body.cursor", script)
        with mock.patch.object(MODULE, "backend_lookup", return_value={"found": False, "searched": True}):
            self.assertEqual(MODULE.locate_outpost_turn("abc123")[0], "absent")
        with mock.patch.object(MODULE, "backend_lookup", return_value={"found": False, "searched": False}):
            self.assertEqual(MODULE.locate_outpost_turn("abc123")[0], "unknown")
        with mock.patch.object(MODULE, "backend_lookup", return_value=None):
            self.assertEqual(MODULE.locate_outpost_turn("abc123")[0], "unknown")
        with mock.patch.object(
            MODULE, "backend_lookup",
            return_value={"found": True, "searched": True, "conversationUrl": "https://chatgpt.com/c/1"},
        ):
            self.assertEqual(MODULE.locate_outpost_turn("abc123")[0], "found")

    def test_recover_finds_a_turn_by_its_id_when_the_run_saved_no_conversation(self) -> None:
        for state, located, expected_code, expected_status in (
            ("found", {"found": True, "conversationUrl": "https://chatgpt.com/c/6abb5830"}, 0, None),
            ("absent", {"found": False, "searched": True}, 75, "not_sent"),
            ("unknown", None, 76, "submit_unknown"),
        ):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                evidence = root / "result.json"
                evidence.write_text(json.dumps({
                    "ok": False, "status": "not_sent", "id": "cb4f4ead", "quality": "xhigh",
                    "conversationUrl": "", "packetSha": "sha", "startedAt": 1790662678.0,
                }), encoding="utf-8")
                recover = mock.MagicMock(return_value={
                    "ok": True, "responseText": "answer", "finished": True, "idMatched": True,
                    "conversationUrl": "https://chatgpt.com/c/6abb5830", "modelSlug": MODULE.required_model_slug("xhigh"),
                })
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None), mock.patch.object(
                    MODULE, "locate_outpost_turn", return_value=(state, located)
                ) as locate, mock.patch.object(MODULE, "recover_outpost_from_backend", recover):
                    code = MODULE.main([
                        "--recover-from", str(evidence),
                        "--url", "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project",
                        "--response-output", str(root / "response.md"),
                        "--json-output", str(evidence),
                        "--stderr-output", str(root / "recover.stderr.log"),
                    ])
                self.assertEqual(code, expected_code)
                self.assertEqual(
                    locate.call_args.kwargs["project_url"],
                    "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project",
                )
                saved = json.loads(evidence.read_text(encoding="utf-8"))
                if expected_status is None:
                    self.assertTrue(saved["ok"])
                    self.assertEqual(recover.call_args.kwargs["conversation_url"], "https://chatgpt.com/c/6abb5830")
                else:
                    self.assertEqual(saved["status"], expected_status)
                    recover.assert_not_called()

    def test_a_renamed_attachment_chip_still_counts_as_attached(self) -> None:
        script = MODULE.build_repl_script(
            project_url="https://chatgpt.com/g/g-p-test-work/project",
            quality="xhigh",
            packet_name="outpost-abc123.md",
            packet_path="/tmp/packet.md",
            topic="t",
            outpost_id="abc123",
            response_timeout_ms=1000,
        )
        # ChatGPT shows a name it has seen before as outpost-abc123(1).md.
        self.assertIn('var packetStem = "outpost-abc123";', script)
        self.assertIn("indexOf(packetStem)", script)

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

    def test_an_attachment_past_the_argument_limit_is_staged_not_inlined(self) -> None:
        # 2026-10-03: a 1.26 MB zip inlined as base64 overflowed the 1 MB
        # command-line limit and `aside repl` never started.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            record = root / "record.json"
            fake = root / "aside"
            fake.write_text(
                f"""#!/usr/bin/env python3
import json, re, sys
script = sys.argv[-1]
packet = json.loads(re.search(r"var packetFile = (.*);", script).group(1))
uploads = json.loads(re.search(r"var extraUploads = (.*);", script).group(1))
json.dump({{
    "scriptBytes": len(script.encode("utf-8")),
    "packet": open(packet, encoding="utf-8").read(),
    "uploads": [open(u["path"], "rb").read().hex() for u in uploads],
    "names": [u["name"] for u in uploads],
}}, open({str(record)!r}, "w"))
print('ASIDE_REPL_SUBMIT_UNKNOWN {{"quality":"pro","reason":"commit unverified"}}')
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
            big = root / "evidence.bin"
            payload = os.urandom(2 * 1024 * 1024)
            big.write_bytes(payload)
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                with mock.patch.object(MODULE, "ensure_aside_daemon", return_value=None):
                    result = MODULE.main(
                        [
                            "--quality", "pro",
                            "--packet", str(packet),
                            "--attach-input", str(big),
                            "--url", "https://chatgpt.com/g/g-p-test-work/project",
                            "--response-output", str(root / "response.md"),
                            "--json-output", str(root / "result.json"),
                            "--stderr-output", str(root / "stderr.log"),
                        ]
                    )
                staging = Path(os.environ[MODULE.ASIDE_ROOT_ENV]) / MODULE.STAGING_SUBDIR

            self.assertEqual(result, 76)
            seen = json.loads(record.read_text(encoding="utf-8"))
            self.assertLess(seen["scriptBytes"], 256 * 1024)
            self.assertEqual(seen["uploads"], [payload.hex()])
            self.assertEqual(seen["names"], ["evidence.bin"])
            self.assertIn("question", seen["packet"])
            # The staged copy is removed once the run ends.
            self.assertEqual(list(staging.iterdir()), [])

    def test_a_send_that_cannot_stage_is_proved_unsent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "aside"
            fake.write_text("#!/usr/bin/env python3\nprint('Aside daemon is not reachable')\n", encoding="utf-8")
            fake.chmod(0o755)
            packet = root / "packet.md"
            packet.write_text("# Test topic\n\nquestion", encoding="utf-8")
            path = f"{temp}{os.pathsep}{os.environ.get('PATH', '')}"
            with mock.patch.dict(os.environ, {"PATH": path}):
                os.environ.pop(MODULE.ASIDE_ROOT_ENV, None)
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

            self.assertEqual(result, MODULE.NOT_SENT_EXIT)
            final = json.loads((root / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(final["status"], "not_sent")
            self.assertEqual(final["failureStage"], "load-staged-files")

    def test_staging_sweeps_runs_left_by_a_killed_process(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stale = root / MODULE.STAGING_SUBDIR / "old-run"
            stale.mkdir(parents=True)
            old = MODULE.time.time() - MODULE.STAGING_MAX_AGE_SECONDS - 60
            os.utime(stale, (old, old))

            staging, packet_path, staged = MODULE.stage_payload(
                root, "new-run", b"packet", [{"name": "a.zip", "mime": "application/zip", "data": b"zip"}]
            )

            self.assertFalse(stale.exists())
            self.assertEqual(Path(packet_path).read_bytes(), b"packet")
            self.assertEqual(Path(staged[0]["path"]).read_bytes(), b"zip")
            self.assertEqual(staging.parent, root / MODULE.STAGING_SUBDIR)

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
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"GPT-6","tier":"Pro (5 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}')
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
                            "responseText": "backend answer", "modelSlug": "gpt-6-pro",
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
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"GPT-6","tier":"Pro (5 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}')
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
                            # recovery waits for the reply between short lookups
                            "--response-timeout", "1",
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
print('ASIDE_REPL_SUBMIT_RESULT {{"quality":"pro","model":"GPT-6","tier":"Pro (5 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1","targetId":"target"}}')
print('ASIDE_REPL_RESPONSE_RESULT {{"modelSlug":"gpt-6-pro","responseText":"ID: placeholder","artifact":{{"temporaryPath":{json.dumps(str(temporary_artifact))},"suggestedFilename":"downloaded.zip"}},"responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/1"}}')
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
                        "model": "GPT-6",
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
                        "responseText": "recovered later", "modelSlug": "gpt-6-pro",
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
            ["--thread", "abcd1234", "--quality", "pro", "--packet", "p"]
        )
        self.assertEqual(continued.thread, "abcd1234")
        self.assertEqual(continued.quality, "pro")
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["--list", "--quality", "pro", "--packet", "p"])
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["--thread", "abcd1234"])
        with self.assertRaises(SystemExit):
            MODULE.parse_args(
                [
                    "--thread", "abcd",
                    "--conversation-url", "https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
                    "--quality", "pro",
                    "--packet", "p",
                ]
            )
        with self.assertRaises(SystemExit):
            MODULE.parse_args(
                [
                    "--conversation-url", "https://chatgpt.com/g/g-p-x/project",
                    "--quality", "pro",
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
            quality="pro",
            packet_name="packet.md",
            packet_path="/tmp/packet.md",
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
            quality="pro",
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
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"GPT-6","tier":"매우 높음 (4 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef","targetId":"target"}')
print('ASIDE_REPL_RESPONSE_RESULT {"modelSlug":"gpt-6-pro","responseText":"answer","idMatched":false,"packetUnread":false,"responseElapsedMs":5678,"conversationUrl":"https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef"}')
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
                            "--quality", "pro",
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
                            "--quality", "pro",
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
                            "--quality", "pro",
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
print('ASIDE_REPL_SUBMIT_RESULT {"quality":"pro","model":"GPT-6","tier":"매우 높음 (4 of 5)","submitElapsedMs":1234,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/c/6a99ef53-3d80-83ee-a84c-187e4a415929","targetId":"target"}')
print('ASIDE_REPL_RESPONSE_RESULT {"modelSlug":"gpt-6-pro","responseText":"answer","idMatched":true,"packetUnread":false,"responseElapsedMs":25,"conversationUrl":"https://chatgpt.com/g/g-p-test-work/project"}')
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
                            "--quality", "pro",
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
                    "--quality", "pro",
                    "--packet", str(packet),
                    "--url", "https://chatgpt.com/g/g-p-test-work/project",
                    "--response-output", str(root / "c.md"),
                    "--json-output", str(root / "c.json"),
                    "--stderr-output", str(root / "c.log"),
                ]),
                topic="Outpost 경로 확인",
                quality="pro",
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
            quality="pro",
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
                "--quality", "pro",
                "--packet", str(packet),
                "--url", "https://chatgpt.com/g/g-p-test-work/project",
                "--response-output", str(packet.with_name("r.md")),
                "--json-output", str(packet.with_name("r.json")),
                "--stderr-output", str(packet.with_name("r.log")),
            ]),
            topic="복구",
            quality="pro",
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
            quality="pro",
            packet_name="outpost-x.md",
            packet_path="/tmp/packet.md",
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
