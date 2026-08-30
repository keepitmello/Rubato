from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "consult_history.py"
SPEC = importlib.util.spec_from_file_location("consult_history_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConsultHistoryTest(unittest.TestCase):
    def test_append_only_events_collapse_into_one_recent_topic(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            history = Path(root_name) / "consult-history.jsonl"
            MODULE.append_event(history, {
                "runId": "run-a",
                "event": "started",
                "status": "starting",
                "topic": "제품 프레이밍 검토",
                "promptHash": "abc",
                "at": "2026-08-03T21:00:00+09:00",
            })
            MODULE.append_event(history, {
                "runId": "run-a",
                "event": "submitted",
                "status": "submitted",
                "sessionId": "session-a",
                "at": "2026-08-03T21:00:05+09:00",
            })

            runs = MODULE.collapse_runs(MODULE.read_events(history))

        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["topic"], "제품 프레이밍 검토")
        self.assertEqual(runs[0]["sessionId"], "session-a")
        self.assertEqual(runs[0]["status"], "submitted")

    def test_recovery_finds_agbrowse_session_by_prompt_hash(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            home = Path(root_name)
            (home / MODULE.SESSION_STORE_FILENAME).write_text(json.dumps({
                "sessions": [{
                    "sessionId": "candidate-session",
                    "promptHash": "sha256:abc",
                    "status": "sent",
                    "conversationUrl": "https://chatgpt.com/c/candidate",
                    "createdAt": "2026-08-03T12:00:00Z",
                }],
            }), encoding="utf-8")

            candidates = MODULE.session_candidates(home, {"promptHash": "abc"})

        self.assertEqual([item["sessionId"] for item in candidates], ["candidate-session"])

    def test_recent_run_is_enriched_with_current_provider_state(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            home = Path(root_name)
            (home / MODULE.SESSION_STORE_FILENAME).write_text(json.dumps({
                "sessions": [{
                    "sessionId": "session-a",
                    "status": "complete",
                    "updatedAt": "2026-08-03T12:30:00Z",
                    "lastResponseCharCount": 321,
                    "conversationUrl": "https://chatgpt.com/c/a",
                }],
            }), encoding="utf-8")
            (home / MODULE.ACTIVE_COMMANDS_FILENAME).write_text(json.dumps({
                "commands": [{
                    "sessionId": "seed-session",
                    "status": "running",
                    "command": "web-ai poll",
                    "heartbeatAt": "2026-08-03T12:31:00Z",
                }],
            }), encoding="utf-8")

            enriched = MODULE.enrich_runs(home, [{
                "runId": "run-a", "sessionId": "session-a", "requestedSessionId": "seed-session",
            }])

        self.assertEqual(enriched[0]["providerStatus"], "complete")
        self.assertEqual(enriched[0]["providerResponseChars"], 321)
        self.assertEqual(enriched[0]["runtimeStatus"], "running")


if __name__ == "__main__":
    unittest.main()
