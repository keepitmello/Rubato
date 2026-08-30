from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


HELPER = Path(__file__).resolve().parents[1] / "scripts" / "run_agbrowse_consult.py"


FAKE_AGBROWSE = r'''#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time


def value(name):
    index = sys.argv.index(name)
    return sys.argv[index + 1]


command = sys.argv[2]
state_dir = Path(os.environ["BROWSER_AGENT_HOME"]) / "fake-provider-state"
state_dir.mkdir(parents=True, exist_ok=True)

if command == "send":
    prompt = value("--prompt")
    attachment_policy = "upload" if "--file" in sys.argv else "inline-only"
    source = Path(value("--file")).read_text(encoding="utf-8") if attachment_policy == "upload" else prompt
    attachment_path = Path(value("--file")) if attachment_policy == "upload" else None
    if os.environ.get("FAKE_ARGV_LOG"):
        Path(os.environ["FAKE_ARGV_LOG"]).write_text(json.dumps(sys.argv[1:]), encoding="utf-8")
    if os.environ.get("FAKE_ENV_LOG"):
        Path(os.environ["FAKE_ENV_LOG"]).write_text(json.dumps({
            "rawPrompt": os.environ.get("CONSULT_AGBROWSE_RAW_PROMPT"),
            "nodeOptions": os.environ.get("NODE_OPTIONS"),
        }), encoding="utf-8")
    hash_payload = {
        "vendor": "chatgpt", "system": "", "prompt": prompt, "project": "", "goal": "",
        "context": "", "question": prompt, "output": "", "constraints": "",
        "attachmentPolicy": attachment_policy,
    }
    prompt_hash = hashlib.sha256(json.dumps(hash_payload, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    session_id = f"fake-session-{prompt_hash[:16]}"
    url = f"https://chatgpt.com/c/{session_id}"
    state = {
        "prompt": prompt,
        "source": source,
        "promptHash": prompt_hash,
        "sessionId": session_id,
        "url": url,
    }
    (state_dir / f"{session_id}.json").write_text(json.dumps(state), encoding="utf-8")

    activity_log = os.environ.get("FAKE_ACTIVITY_LOG")
    if activity_log:
        with open(activity_log, "a", encoding="utf-8") as handle:
            handle.write(f"start {os.getpid()}\n")
    if os.environ.get("FAKE_STDERR_LINES"):
        print("fake provider started", file=sys.stderr, flush=True)
    sleep_seconds = float(os.environ.get("FAKE_SLEEP_SECONDS", "0"))
    if sleep_seconds:
        time.sleep(sleep_seconds)
    if os.environ.get("FAKE_VERIFY_ATTACHMENT_AFTER_SLEEP") and attachment_path is not None and not attachment_path.exists():
        print("active packet disappeared before provider completion", file=sys.stderr, flush=True)
        raise SystemExit(8)
    if os.environ.get("FAKE_STDERR_LINES"):
        print("fake provider finished", file=sys.stderr, flush=True)
    if activity_log:
        with open(activity_log, "a", encoding="utf-8") as handle:
            handle.write(f"end {os.getpid()}\n")
    print(json.dumps({
        "ok": True,
        "vendor": "chatgpt",
        "status": "sent",
        "url": url,
        "sessionId": session_id,
        "baseline": {"vendor": "chatgpt", "url": url, "promptHash": prompt_hash},
    }))
    raise SystemExit(0)

if command != "poll":
    raise SystemExit(f"unsupported fake command: {command}")

session_id = value("--session")
state = json.loads((state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
prompt = state["prompt"]
source = state["source"]
prompt_hash = state["promptHash"]
url = state["url"]
run_match = re.search(r"^CONSULT_RUN_ID: .+$", prompt, re.MULTILINE)
packet_match = re.search(r"^CONSULT_PACKET_ID: .+$", source, re.MULTILINE)
run_line = run_match.group(0) if run_match else ""
packet_line = packet_match.group(0) if packet_match else ""
mode = os.environ.get("FAKE_AGBROWSE_MODE", "normal")
if mode in {"misrouted", "misrouted-nonzero"}:
    run_line = "CONSULT_RUN_ID: another-run"
    packet_line = "CONSULT_PACKET_ID: another-packet"
body = (
    "한국어 응답 보존 확인 — 멀티바이트 저장 경계 테스트\u3000"
    if os.environ.get("FAKE_KOREAN_ANSWER")
    else ("Fish Audio input answered" if "Fish Audio" in source else "Autonomy input answered")
)
answer = f"{run_line}\n{packet_line}\n\n{body}\n"
artifact_session_id = "another-session" if mode == "metadata-mismatch" else session_id
payload = {
    "ok": mode not in {"misrouted-nonzero", "partial-nonzero"},
    "vendor": "chatgpt",
    "status": "failed" if mode in {"misrouted-nonzero", "partial-nonzero"} else "complete",
    "url": url,
    "sessionId": session_id,
    "answerText": answer,
    "baseline": {"vendor": "chatgpt", "url": url, "promptHash": prompt_hash},
    "answerArtifact": {
        "provider": "chatgpt", "sessionId": artifact_session_id, "conversationUrl": url,
        "markdown": answer, "text": answer,
    },
}
print(json.dumps(payload, ensure_ascii=False))
if mode in {"misrouted-nonzero", "partial-nonzero"}:
    raise SystemExit(9)
'''


class ConsultHelperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        fake = self.bin_dir / "agbrowse"
        fake.write_text(FAKE_AGBROWSE, encoding="utf-8")
        fake.chmod(0o755)
        self.launcher = self.root / "ensure-consult-chrome"
        self.launcher.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.launcher.chmod(0o755)
        self.browser_home = self.root / "browser-home"
        self.upload_instructions = self.root / "upload.md"
        self.upload_instructions.write_text("Read the attached packet and answer it.", encoding="utf-8")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def env(self, **overrides: str) -> dict[str, str]:
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bin_dir}{os.pathsep}{env.get('PATH', '')}",
            "CONSULT_BROWSER_AGENT_HOME": str(self.browser_home),
            "CONSULT_CHROME_LAUNCHER": str(self.launcher),
            "CONSULT_CHATGPT_URL": "https://chatgpt.com/g/g-p-test-work/project",
        })
        env.update(overrides)
        return env

    def command(self, *, packet: Path | None, prompt_file: Path | None, stem: str) -> list[str]:
        command = [
            sys.executable,
            str(HELPER),
            "--quality", "xhigh",
            "--upload-instructions", str(self.upload_instructions),
            "--response-output", str(self.root / f"{stem}-response.md"),
            "--json-output", str(self.root / f"{stem}-response.json"),
            "--stderr-output", str(self.root / f"{stem}-stderr.log"),
            "--trace-dir", str(self.root / f"{stem}-trace"),
            "--session-file", str(self.root / f"{stem}-session.json"),
            "--turns-output", str(self.root / f"{stem}-turns.jsonl"),
            "--lock-timeout", "5",
        ]
        if packet is not None:
            command.extend(["--packet", str(packet)])
        if prompt_file is not None:
            command.extend(["--prompt-file", str(prompt_file)])
        return command

    def run_helper(self, command: list[str], **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command,
            cwd=self.root,
            env=self.env(**env),
            text=True,
            capture_output=True,
            check=False,
        )

    def replace_arg(self, command: list[str], name: str, value: Path | str) -> list[str]:
        updated = list(command)
        updated[updated.index(name) + 1] = str(value)
        return updated

    def test_explicit_prompt_file_is_the_upload_source_when_packet_is_omitted(self) -> None:
        stale = self.root / ".consult" / "consult-packet.md"
        stale.parent.mkdir()
        stale.write_text("Agent autonomy and Matrix", encoding="utf-8")
        intended = self.root / "emotion.md"
        intended.write_text("Fish Audio panting and breathy question", encoding="utf-8")

        result = self.run_helper(self.command(packet=None, prompt_file=intended, stem="normal"))

        self.assertEqual(result.returncode, 0, result.stderr)
        response = (self.root / "normal-response.md").read_text(encoding="utf-8")
        self.assertIn("Fish Audio input answered", response)
        self.assertNotIn("Autonomy input answered", response)
        self.assertNotIn("CONSULT_RUN_ID", response)
        turn = json.loads((self.root / "normal-turns.jsonl").read_text(encoding="utf-8"))
        self.assertEqual(turn["inputSource"], str(intended))
        self.assertEqual(turn["correlationStatus"], "validated")

    def test_initial_call_uses_agbrowse_parallel_mode(self) -> None:
        packet = self.root / "parallel-mode.md"
        packet.write_text("Fish Audio parallel mode", encoding="utf-8")
        argv_log = self.root / "parallel-mode-argv.json"

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="parallel-mode"),
            FAKE_ARGV_LOG=str(argv_log),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(argv_log.read_text(encoding="utf-8"))
        self.assertIn("--parallel", invocation)
        self.assertNotIn("--new-tab", invocation)

    def test_global_chat_url_is_rejected_before_provider_launch(self) -> None:
        packet = self.root / "global-chat.md"
        packet.write_text("This must stay inside Work.", encoding="utf-8")
        command = self.command(packet=packet, prompt_file=None, stem="global-chat")
        command.extend(["--url", "https://chatgpt.com/"])

        result = self.run_helper(command)

        self.assertEqual(result.returncode, 2)
        self.assertIn("requires a verified ChatGPT Work project URL", result.stderr)
        self.assertFalse((self.root / "global-chat-response.send.json").exists())

    def test_missing_quality_is_rejected_before_provider_launch(self) -> None:
        packet = self.root / "missing-quality.md"
        packet.write_text("Quality must be explicit.", encoding="utf-8")
        command = self.command(packet=packet, prompt_file=None, stem="missing-quality")
        quality_index = command.index("--quality")
        del command[quality_index:quality_index + 2]

        result = self.run_helper(command)

        self.assertEqual(result.returncode, 2)
        self.assertIn("--quality is required", result.stderr)
        self.assertFalse((self.root / "missing-quality-response.send.json").exists())

    def test_success_records_topic_submit_receipt_and_completion_in_shared_history(self) -> None:
        packet = self.root / "history.md"
        packet.write_text("## Question\n\n제품 프레이밍 검토가 필요한가요?\n", encoding="utf-8")

        result = self.run_helper(self.command(packet=packet, prompt_file=None, stem="history"))

        self.assertEqual(result.returncode, 0, result.stderr)
        events = [
            json.loads(line)
            for line in (self.browser_home / "consult-history.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual([event["event"] for event in events], ["started", "submitted", "completed"])
        self.assertEqual(events[0]["topic"], "제품 프레이밍 검토가 필요한가요?")
        self.assertTrue(events[1]["sessionId"].startswith("fake-session-"))
        self.assertEqual(events[2]["status"], "complete")
        self.assertTrue((self.root / "history-response.send.json").exists())

    def test_initial_call_enables_verbatim_prompt_transport(self) -> None:
        packet = self.root / "raw-prompt.md"
        packet.write_text("## Question\n\n실제 제목을 그대로 보내 주세요.\n", encoding="utf-8")
        env_log = self.root / "raw-prompt-env.json"

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="raw-prompt"),
            FAKE_ENV_LOG=str(env_log),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        child_env = json.loads(env_log.read_text(encoding="utf-8"))
        self.assertEqual(child_env["rawPrompt"], "1")
        self.assertIn("agbrowse_raw_prompt_register.mjs", child_env["nodeOptions"])

    def test_loader_adds_pointer_fallback_for_current_chatgpt_model_pill(self) -> None:
        loader = HELPER.parent / "agbrowse_raw_prompt_loader.mjs"
        script = r'''
const { load } = await import(process.argv[1]);
process.env.CONSULT_AGBROWSE_RAW_PROMPT = '1';
const marker = `            await composerPill.click({ timeout: 5_000 });
            await page.waitForTimeout(400).catch(() => undefined);
            if (await isModelMenuOpen(page)) {
                await assertOpenMenuIsNotWorkPicker(page);
                return;
            }`;
const powerRoot = `const CHATGPT_POWER_PICKER_ROOT_SELECTOR =
    '[role="menu"][data-state="open"]:has([role="menuitem"][aria-label="Power"])';`;
const preflight = `async function assertChatSurfaceForModelMutation(page) {
    const { detectChatGptComposerSurface } = await import('./product-surfaces.mjs');`;
const simplifiedPickerOpen = `    const visible = await menu.isVisible().catch(() => false);
    if (!visible) return false;
    if (!model && !effort && await isChatGptPowerPickerOpen(page)) return true;`;
const sliderState = `async function readChatGptPowerSliderState(page) {`;
const sliderDriver = `async function selectChatGptPowerTierBySlider(page, choice, options = {}) {
    if (!(await isChatGptPowerPickerOpen(page))) return false;
    const effort = options.effort || null;
    const usedFallbacks = options.usedFallbacks || [];
    const targetIndex = powerTierIndexForChoice(choice, effort);
    const power = page.locator('[role="menuitem"][aria-label="Power"]').first();
    if (!(await power.isVisible().catch(() => false))) return false;
    await power.focus({ timeout: 1_000 }).catch(() => undefined);
    await power.click({ timeout: 2_000 }).catch(() => undefined);`;
const sliderCalls = `if (await isChatGptPowerPickerOpen(page)
                    && await selectChatGptPowerTierBySlider`;
const currentModelOption = `    // Current path: exact labels in composer-scoped menu root.`;
const checkedModelSlider = `    const powerPickerOpen = await isChatGptPowerPickerOpen(page);
    if (powerPickerOpen) {
        const sliderState = await readChatGptPowerSliderState(page);`;
const observedEffortSlider = `    if (requestedEffort && targetModel === 'thinking' && await isChatGptPowerPickerOpen(page)) {`;
const simpleSliderFallback = `            if (!sliderApplied) {
                try {`;
const simplifiedEffortEvidence = `        const simplifiedSelected = currentEvidence?.label
            ? effortChoiceFromSimplifiedText(currentEvidence.label, /** @type {string} */ (targetModel), requestedEffort)
            : null;`;
// The Power-shell submenu probe lines must be present in the stub, otherwise the
// locale-widening replacements below have nothing to match and the Korean
// assertions fail unconditionally rather than testing anything.
const submenuProbe = `        hasModel ||= menuTextHasExactLine(text, 'Model');
        hasEffort ||= menuTextHasExactLine(text, 'Effort');
        if (menuTextHasExactLine(text, heading)) return trigger;`;
// The loader also widens both Power-root locator call sites to accept the
// Korean aria-label, and fails closed when either anchor is missing.
const powerLocators = "    const a = root.locator('[role=\"menuitem\"][aria-label=\"Power\"]').first();\n"
    + "    const b = page.locator('[role=\"menuitem\"][aria-label=\"Power\"]').last();";
const result = await load(
    'file:///tmp/agbrowse/web-ai/chatgpt-model.mjs',
    {},
    async () => ({ format: 'module', source: `${powerRoot}\n${preflight}\n${simplifiedPickerOpen}\n${sliderState}\n${sliderDriver}\n${sliderCalls}\n${sliderCalls}\n${currentModelOption}\n${checkedModelSlider}\n${observedEffortSlider}\n${simpleSliderFallback}\n${simplifiedEffortEvidence}\n${marker}\n${submenuProbe}\n${powerLocators}` }),
);
process.stdout.write(String(result.source));
'''
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, loader.resolve().as_uri()],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("composer-model-pill-pointer", result.stdout)
        self.assertIn("page.mouse.click", result.stdout)
        # Assert the widened pair, not the bare English label: the stub already
        # supplies '[aria-label="Power"]', so checking it alone proves nothing.
        # Both locator call sites must carry the Korean alternative.
        self.assertIn(
            'root.locator(\'[role="menuitem"][aria-label="Power"], '
            '[role="menuitem"][aria-label="성능"]\')',
            result.stdout,
        )
        self.assertIn(
            'page.locator(\'[role="menuitem"][aria-label="Power"], '
            '[role="menuitem"][aria-label="성능"]\')',
            result.stdout,
        )
        # The retired Work-picker testid must never be reintroduced as the Power
        # root. The stub omits it, so this guards the loader's own output only.
        self.assertNotIn("composer-intelligence-picker-content", result.stdout)
        self.assertIn("modal-conversation-history-rate-limit", result.stdout)
        # The localized simple picker keeps its model radios in a hidden
        # advanced panel. Open detection must use the visible slider rather
        # than scanning only those hidden rows, or every retry closes the menu.
        self.assertIn(
            "const effortSlider = simpleView.locator(",
            result.stdout,
        )
        self.assertIn(
            "'[data-model-reasoning-effort-slider]'",
            result.stdout,
        )
        self.assertNotIn(
            "    const visible = await menu.isVisible().catch(() => false);\n"
            "    if (!visible) return false;\n"
            "    if (!model && !effort && await isChatGptPowerPickerOpen(page)) return true;",
            result.stdout,
        )
        self.assertIn("async function isChatGptTierSliderOpen(page)", result.stdout)
        self.assertIn(
            "if (!(await isChatGptTierSliderOpen(page))) return false;",
            result.stdout,
        )
        self.assertIn(
            '[role="menuitem"]:has([data-model-reasoning-effort-slider])',
            result.stdout,
        )
        self.assertEqual(
            result.stdout.count(
                "if (await isChatGptTierSliderOpen(page)\n"
                "                    && await selectChatGptPowerTierBySlider"
            ),
            2,
        )
        self.assertIn(
            "if (await isChatGptTierSliderOpen(page)) return null;",
            result.stdout,
        )
        self.assertIn(
            "const tierSliderOpen = await isChatGptTierSliderOpen(page);",
            result.stdout,
        )
        self.assertIn(
            "requestedEffort && targetModel === 'thinking' "
            "&& await isChatGptTierSliderOpen(page)",
            result.stdout,
        )
        self.assertIn("element.ownerDocument.activeElement", result.stdout)
        self.assertIn(
            "if (!sliderApplied && await isChatGptTierSliderOpen(page))",
            result.stdout,
        )
        self.assertIn(
            "reasoning-effort-slider-unverified",
            result.stdout,
        )
        self.assertIn(
            "const simplifiedSelected = !tierSliderOpen && currentEvidence?.label",
            result.stdout,
        )
        self.assertNotIn(
            "if (!(await isChatGptPowerPickerOpen(page))) return false;",
            result.stdout,
        )
        # The live Korean Power shell labels the effort submenu trigger '추론 수준'.
        # '추론 강도' never appeared in the DOM and silently disabled effort
        # enforcement, so the current label is what must be pinned here.
        #
        # agbrowse requires BOTH headings via two independent code paths -- the
        # hasModel/hasEffort probe and the submenu-trigger lookup. Asserting the
        # bare literal would let either rewrite be deleted while the other kept
        # the string present, so pin each transformed line separately.
        self.assertIn(
            "hasModel ||= menuTextHasExactLine(text, 'Model') "
            "|| menuTextHasExactLine(text, '모델');",
            result.stdout,
        )
        self.assertIn(
            "hasEffort ||= menuTextHasExactLine(text, 'Effort') "
            "|| menuTextHasExactLine(text, '추론 수준')",
            result.stdout,
        )
        self.assertIn("heading === 'Model' && menuTextHasExactLine(text, '모델')", result.stdout)
        self.assertIn("heading === 'Effort' && (menuTextHasExactLine(text, '추론 수준')", result.stdout)
        # No original anchor may survive: a surviving anchor means that
        # replacement silently no-opped.
        self.assertNotIn("hasEffort ||= menuTextHasExactLine(text, 'Effort');", result.stdout)
        self.assertNotIn("if (menuTextHasExactLine(text, heading)) return trigger;", result.stdout)

    def test_initial_call_derives_distinct_title_and_adds_open_korean_preference(self) -> None:
        packet = self.root / "title.md"
        packet.write_text(
            "## Question\n\n정책 드리프트 탐지 실패의 소유 경계를 검토해 주세요.\n",
            encoding="utf-8",
        )
        argv_log = self.root / "title-argv.json"

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="title"),
            FAKE_ARGV_LOG=str(argv_log),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(argv_log.read_text(encoding="utf-8"))
        prompt = invocation[invocation.index("--prompt") + 1]
        self.assertTrue(prompt.startswith("# 정책 드리프트 탐지 실패의 소유 경계를 검토해 주세요."))
        self.assertIn("답변은 한국어 보고서로", prompt)
        self.assertIn("구조와 표현을 자유롭게 선택", prompt)
        self.assertNotIn("결론→근거→조치", prompt)

    def test_generic_consult_question_heading_is_not_used_as_the_title(self) -> None:
        packet = self.root / "generic-heading.md"
        packet.write_text(
            "# Consult question\n\n실제 동시 실행 소유권을 어떻게 나눠야 하나요?\n\n## Evidence\n\n근거\n",
            encoding="utf-8",
        )
        argv_log = self.root / "generic-heading-argv.json"

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="generic-heading"),
            FAKE_ARGV_LOG=str(argv_log),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(argv_log.read_text(encoding="utf-8"))
        prompt = invocation[invocation.index("--prompt") + 1]
        self.assertTrue(prompt.startswith("# 실제 동시 실행 소유권을 어떻게 나눠야 하나요?"))
        self.assertNotIn("# Consult question", prompt)

    def test_explicit_title_overrides_packet_derived_title(self) -> None:
        self.upload_instructions.write_text(
            "# Consult: 오래된 준비 단계 제목\n\nRead the attached packet and answer it.\n",
            encoding="utf-8",
        )
        packet = self.root / "explicit-title.md"
        packet.write_text("## Question\n\n긴 질문 원문입니다.\n", encoding="utf-8")
        argv_log = self.root / "explicit-title-argv.json"
        command = self.command(packet=packet, prompt_file=None, stem="explicit-title")
        command.extend(["--title", "드리프트 소유권 검토"])

        result = self.run_helper(command, FAKE_ARGV_LOG=str(argv_log))

        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(argv_log.read_text(encoding="utf-8"))
        prompt = invocation[invocation.index("--prompt") + 1]
        self.assertTrue(prompt.startswith("# 드리프트 소유권 검토"))
        self.assertNotIn("# Consult:", prompt)
        self.assertNotIn("오래된 준비 단계 제목", prompt)

    def test_legacy_english_helper_preamble_is_localized_before_send(self) -> None:
        self.upload_instructions.write_text(
            "Please review the uploaded self-contained repository-context packet and answer the question inside it.\n\n"
            "Assume you cannot see the repository, terminal, or earlier conversation beyond the uploaded packet. "
            "If the packet lacks evidence for a claim, say so.\n",
            encoding="utf-8",
        )
        packet = self.root / "legacy-preamble.md"
        packet.write_text("## Question\n\n기존 프리앰블 호환성을 확인해 주세요.\n", encoding="utf-8")
        argv_log = self.root / "legacy-preamble-argv.json"

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="legacy-preamble"),
            FAKE_ARGV_LOG=str(argv_log),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(argv_log.read_text(encoding="utf-8"))
        prompt = invocation[invocation.index("--prompt") + 1]
        self.assertIn("첨부한 독립형 컨텍스트 패킷을 검토하고", prompt)
        self.assertNotIn("Please review", prompt)
        self.assertNotIn("Assume you cannot see", prompt)

    def test_korean_response_is_saved_without_loss(self) -> None:
        packet = self.root / "korean.md"
        packet.write_text("Fish Audio 한국어 입력", encoding="utf-8")

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="korean"),
            FAKE_KOREAN_ANSWER="1",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        response = (self.root / "korean-response.md").read_text(encoding="utf-8")
        self.assertIn("한국어 응답 보존 확인", response)
        self.assertIn("테스트\u3000", response)
        self.assertNotIn("�", response)

    def test_misrouted_receipts_are_quarantined_and_exit_nonzero(self) -> None:
        packet = self.root / "emotion.md"
        packet.write_text("Fish Audio panting and breathy question", encoding="utf-8")

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="misroute"),
            FAKE_AGBROWSE_MODE="misrouted",
        )

        self.assertEqual(result.returncode, 3, result.stderr)
        rejected = (self.root / "misroute-response.md").read_text(encoding="utf-8")
        self.assertIn("CONSULT RESPONSE REJECTED", rejected)
        self.assertIn("MISROUTED-misroute-response.md", rejected)
        self.assertFalse((self.root / "misroute-response.json").exists())
        quarantined_response = self.root / "MISROUTED-misroute-response.md"
        quarantined_json = self.root / "MISROUTED-misroute-response.json"
        self.assertTrue(quarantined_response.exists())
        self.assertTrue(quarantined_json.exists())
        quarantine_text = quarantined_response.read_text(encoding="utf-8")
        self.assertIn("response run receipt does not match", quarantine_text)
        self.assertIn("another-run", quarantine_text)
        turn = json.loads((self.root / "misroute-turns.jsonl").read_text(encoding="utf-8"))
        self.assertEqual(turn["status"], "misrouted")
        session = json.loads((self.root / "misroute-session.json").read_text(encoding="utf-8"))
        self.assertIsNone(session["sessionId"])
        self.assertEqual(session["status"], "misrouted")

    def test_matching_receipts_still_fail_closed_on_session_metadata_mismatch(self) -> None:
        packet = self.root / "emotion.md"
        packet.write_text("Fish Audio panting and breathy question", encoding="utf-8")

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="metadata"),
            FAKE_AGBROWSE_MODE="metadata-mismatch",
        )

        self.assertEqual(result.returncode, 3, result.stderr)
        quarantine_text = (self.root / "MISROUTED-metadata-response.md").read_text(encoding="utf-8")
        self.assertIn("answer artifact session does not match", quarantine_text)

    def test_nonzero_misrouted_partial_answer_is_still_quarantined(self) -> None:
        packet = self.root / "emotion.md"
        packet.write_text("Fish Audio panting and breathy question", encoding="utf-8")

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="partial"),
            FAKE_AGBROWSE_MODE="misrouted-nonzero",
        )

        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertTrue((self.root / "MISROUTED-partial-response.md").exists())
        self.assertTrue((self.root / "MISROUTED-partial-response.json").exists())
        self.assertIn("CONSULT RESPONSE REJECTED", (self.root / "partial-response.md").read_text(encoding="utf-8"))

    def test_nonzero_correlated_partial_answer_preserves_provider_exit(self) -> None:
        packet = self.root / "partial-correlated.md"
        packet.write_text("Fish Audio correlated partial", encoding="utf-8")

        result = self.run_helper(
            self.command(packet=packet, prompt_file=None, stem="partial-correlated"),
            FAKE_AGBROWSE_MODE="partial-nonzero",
        )

        self.assertEqual(result.returncode, 9, result.stderr)
        self.assertTrue((self.root / "partial-correlated-response.json").exists())
        self.assertFalse((self.root / "partial-correlated-response.md").exists())
        self.assertFalse((self.root / "MISROUTED-partial-correlated-response.md").exists())

    def test_two_processes_sharing_one_profile_run_in_parallel_tabs(self) -> None:
        first_packet = self.root / "first.md"
        second_packet = self.root / "second.md"
        first_packet.write_text("Fish Audio first", encoding="utf-8")
        second_packet.write_text("Fish Audio second", encoding="utf-8")
        activity = self.root / "activity.log"
        env = self.env(FAKE_SLEEP_SECONDS="0.35", FAKE_ACTIVITY_LOG=str(activity))

        first = subprocess.Popen(
            self.command(packet=first_packet, prompt_file=None, stem="first"),
            cwd=self.root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        second = subprocess.Popen(
            self.command(packet=second_packet, prompt_file=None, stem="second"),
            cwd=self.root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        first_stdout, first_stderr = first.communicate(timeout=10)
        second_stdout, second_stderr = second.communicate(timeout=10)

        self.assertEqual(first.returncode, 0, first_stderr or first_stdout)
        self.assertEqual(second.returncode, 0, second_stderr or second_stdout)
        events = activity.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(events), 4)
        self.assertEqual([event.split()[0] for event in events[:2]], ["start", "start"])
        self.assertEqual([event.split()[0] for event in events[2:]], ["end", "end"])
        self.assertNotEqual(events[0].split()[1], events[1].split()[1])

    def test_waiting_process_refuses_to_overwrite_shared_outputs(self) -> None:
        packet = self.root / "shared.md"
        packet.write_text("Fish Audio shared", encoding="utf-8")
        activity = self.root / "shared-activity.log"
        env = self.env(FAKE_SLEEP_SECONDS="0.35", FAKE_ACTIVITY_LOG=str(activity))
        command = self.command(packet=packet, prompt_file=None, stem="shared")

        first = subprocess.Popen(
            command,
            cwd=self.root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        second = subprocess.Popen(
            command,
            cwd=self.root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        first_stdout, first_stderr = first.communicate(timeout=10)
        second_stdout, second_stderr = second.communicate(timeout=10)

        self.assertEqual(sorted([first.returncode, second.returncode]), [0, 75])
        combined = "\n".join([first_stdout, first_stderr, second_stdout, second_stderr])
        self.assertIn("refusing to launch provider", combined)
        events = activity.read_text(encoding="utf-8").splitlines()
        self.assertEqual([event.split()[0] for event in events], ["start", "end"])

    def test_waiting_process_refuses_to_overwrite_shared_stderr(self) -> None:
        first_packet = self.root / "stderr-first.md"
        second_packet = self.root / "stderr-second.md"
        first_packet.write_text("Fish Audio first", encoding="utf-8")
        second_packet.write_text("Fish Audio second", encoding="utf-8")
        activity = self.root / "stderr-activity.log"
        shared_stderr = self.root / "shared-stderr.log"
        env = self.env(FAKE_SLEEP_SECONDS="0.35", FAKE_ACTIVITY_LOG=str(activity))
        first_command = self.replace_arg(
            self.command(packet=first_packet, prompt_file=None, stem="stderr-first"),
            "--stderr-output",
            shared_stderr,
        )
        second_command = self.replace_arg(
            self.command(packet=second_packet, prompt_file=None, stem="stderr-second"),
            "--stderr-output",
            shared_stderr,
        )

        first = subprocess.Popen(first_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(100):
            if activity.exists() and activity.read_text(encoding="utf-8").startswith("start "):
                break
            time.sleep(0.01)
        second = subprocess.Popen(second_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        first_stdout, first_stderr = first.communicate(timeout=10)
        second_stdout, second_stderr = second.communicate(timeout=10)

        self.assertEqual(sorted([first.returncode, second.returncode]), [0, 75])
        combined = "\n".join([first_stdout, first_stderr, second_stdout, second_stderr])
        self.assertIn(str(shared_stderr), combined)
        events = activity.read_text(encoding="utf-8").splitlines()
        self.assertEqual([event.split()[0] for event in events], ["start", "end"])

    def test_parallel_uploads_keep_invocation_owned_packets_until_completion(self) -> None:
        holder_packet = self.root / "holder.md"
        waiter_packet = self.root / "waiter.md"
        holder_packet.write_text("Fish Audio holder", encoding="utf-8")
        waiter_packet.write_text("Fish Audio waiter", encoding="utf-8")
        activity = self.root / "packet-activity.log"
        env = self.env(
            FAKE_SLEEP_SECONDS="0.35",
            FAKE_ACTIVITY_LOG=str(activity),
            FAKE_VERIFY_ATTACHMENT_AFTER_SLEEP="1",
        )
        holder_command = self.command(packet=holder_packet, prompt_file=None, stem="holder")
        waiter_command = self.command(packet=waiter_packet, prompt_file=None, stem="waiter")

        holder = subprocess.Popen(holder_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(100):
            if activity.exists() and activity.read_text(encoding="utf-8").startswith("start "):
                break
            time.sleep(0.01)
        waiter = subprocess.Popen(waiter_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        waiter_stdout, waiter_stderr = waiter.communicate(timeout=10)
        holder_stdout, holder_stderr = holder.communicate(timeout=10)

        self.assertEqual(waiter.returncode, 0, waiter_stderr or waiter_stdout)
        self.assertEqual(holder.returncode, 0, holder_stderr or holder_stdout)
        events = activity.read_text(encoding="utf-8").splitlines()
        self.assertEqual([event.split()[0] for event in events[:2]], ["start", "start"])

    def test_followups_to_same_provider_session_are_serialized(self) -> None:
        activity = self.root / "same-target-activity.log"
        env = self.env(FAKE_SLEEP_SECONDS="0.35", FAKE_ACTIVITY_LOG=str(activity))
        first_command = self.command(packet=None, prompt_file=None, stem="same-target-first")
        first_command.extend(["--follow-up", "Fish Audio first follow-up", "--session", "shared-provider-session"])
        second_command = self.command(packet=None, prompt_file=None, stem="same-target-second")
        second_command.extend(["--follow-up", "Fish Audio second follow-up", "--session", "shared-provider-session"])

        first = subprocess.Popen(first_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        second = subprocess.Popen(second_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        first_stdout, first_stderr = first.communicate(timeout=10)
        second_stdout, second_stderr = second.communicate(timeout=10)

        self.assertEqual(first.returncode, 0, first_stderr or first_stdout)
        self.assertEqual(second.returncode, 0, second_stderr or second_stdout)
        events = activity.read_text(encoding="utf-8").splitlines()
        self.assertEqual([event.split()[0] for event in events], ["start", "end", "start", "end"])

    def test_followup_file_always_uses_attachment_instead_of_inline_composer_fill(self) -> None:
        follow_up = self.root / "followup-packet.md"
        follow_up.write_text("# 제품 프레이밍 후속 검토\n\n짧아도 파일 패킷입니다.\n", encoding="utf-8")
        argv_log = self.root / "followup-packet-argv.json"
        command = self.command(packet=None, prompt_file=None, stem="followup-packet")
        command.extend(["--follow-up-file", str(follow_up), "--session", "existing-session"])

        result = self.run_helper(command, FAKE_ARGV_LOG=str(argv_log))

        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(argv_log.read_text(encoding="utf-8"))
        self.assertIn("--file", invocation)
        self.assertNotIn("--inline-only", invocation)
        prompt = invocation[invocation.index("--prompt") + 1]
        self.assertLess(len(prompt), 3000)
        self.assertNotIn("짧아도 파일 패킷입니다.", prompt)
        history_events = [
            json.loads(line)
            for line in (self.browser_home / "consult-history.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(history_events[0]["mode"], "follow-up-upload")

    def test_short_followup_argument_remains_inline(self) -> None:
        argv_log = self.root / "short-followup-argv.json"
        command = self.command(packet=None, prompt_file=None, stem="short-followup")
        command.extend(["--follow-up", "이 주장 하나만 다시 검토해 주세요.", "--session", "existing-session"])

        result = self.run_helper(command, FAKE_ARGV_LOG=str(argv_log))

        self.assertEqual(result.returncode, 0, result.stderr)
        invocation = json.loads(argv_log.read_text(encoding="utf-8"))
        self.assertIn("--inline-only", invocation)
        self.assertNotIn("--file", invocation)

    def test_explicit_followups_refuse_to_overwrite_shared_session_output(self) -> None:
        shared_session = self.root / "shared-followup-session.json"
        shared_session.write_text(json.dumps({"sessionId": "seed-session"}), encoding="utf-8")
        activity = self.root / "followup-activity.log"
        env = self.env(FAKE_SLEEP_SECONDS="0.35", FAKE_ACTIVITY_LOG=str(activity))
        first_command = self.command(packet=None, prompt_file=None, stem="followup-first")
        first_command.extend(["--follow-up", "Fish Audio first follow-up", "--session", "explicit-session"])
        first_command = self.replace_arg(first_command, "--session-file", shared_session)
        second_command = self.command(packet=None, prompt_file=None, stem="followup-second")
        second_command.extend(["--follow-up", "Fish Audio second follow-up", "--session", "explicit-session"])
        second_command = self.replace_arg(second_command, "--session-file", shared_session)

        first = subprocess.Popen(first_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        second = subprocess.Popen(second_command, cwd=self.root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        first_stdout, first_stderr = first.communicate(timeout=10)
        second_stdout, second_stderr = second.communicate(timeout=10)

        self.assertEqual(sorted([first.returncode, second.returncode]), [0, 75])
        combined = "\n".join([first_stdout, first_stderr, second_stdout, second_stderr])
        self.assertIn(str(shared_session), combined)
        events = activity.read_text(encoding="utf-8").splitlines()
        self.assertEqual([event.split()[0] for event in events], ["start", "end"])


if __name__ == "__main__":
    unittest.main()
