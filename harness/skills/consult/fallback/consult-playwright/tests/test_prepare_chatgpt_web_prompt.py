from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_chatgpt_web_prompt.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("prepare_chatgpt_web_prompt", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrepareChatGPTWebPromptTest(unittest.TestCase):
    def test_full_prompt_retains_korean_packet_text(self) -> None:
        packet = "한국어 입력과 응답을 보존해야 합니다.\u3000"

        rendered = MODULE.build_full_prompt(packet, "packet.md", "")

        self.assertIn(packet, rendered)
        self.assertEqual(rendered.count(packet), 1)
        self.assertGreater(len(rendered.encode("utf-8")), len(rendered))

    def test_upload_prompt_uses_plain_title_and_open_korean_preference(self) -> None:
        packet = """# Packet

## Question

정책 드리프트 탐지 실패의 소유 경계를 검토해 주세요.
"""

        rendered = MODULE.build_upload_instructions("packet.md", "", packet)

        self.assertTrue(rendered.startswith("# 정책 드리프트 탐지 실패의 소유 경계를 검토해 주세요."))
        self.assertNotIn("# Consult:", rendered)
        self.assertIn("첨부한 독립형 컨텍스트 패킷을 검토하고", rendered)
        self.assertIn("답변은 한국어 보고서로", rendered)
        self.assertIn("구조와 표현을 자유롭게 선택", rendered)
        self.assertNotIn("결론→근거→조치", rendered)


if __name__ == "__main__":
    unittest.main()
