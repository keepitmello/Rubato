from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "outpost_sessions.py"
SPEC = importlib.util.spec_from_file_location("outpost_sessions_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConsultSessionsTest(unittest.TestCase):
    def test_create_resolve_and_list_running_then_finished(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MODULE.SessionStore(Path(temp) / "sessions.json")
            first = store.create_thread(
                topic="캐시 깨기",
                quality="xhigh",
                project_name="Work",
                outpost_id="turn-1",
                pid=os.getpid(),
            )
            second = store.create_thread(
                topic="디자인 리뷰",
                quality="pro",
                project_name="Work",
                outpost_id="turn-2",
                pid=os.getpid(),
            )
            store.mark_submitted(
                first["threadId"],
                conversation_url="https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
                target_id="target-a",
                outpost_id="turn-1",
            )
            store.finish_turn(
                first["threadId"],
                status="finished",
                outpost_id="turn-1",
                conversation_url="https://chatgpt.com/g/g-p-x/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
            )

            listed = store.listed_threads()
            self.assertEqual(listed[0]["status"], "running")
            self.assertEqual(listed[0]["threadId"], second["threadId"])
            self.assertEqual(listed[1]["status"], "finished")
            self.assertEqual(
                store.resolve(first["threadId"])["conversationId"],
                "6a95625e-1f78-83e8-aa90-a49f982e36ef",
            )
            self.assertEqual(
                store.resolve("https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef")["threadId"],
                first["threadId"],
            )
            self.assertEqual(store.resolve("캐시")["threadId"], first["threadId"])

    def test_topic_lookup_is_ambiguous_when_two_match(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MODULE.SessionStore(Path(temp) / "sessions.json")
            store.create_thread(topic="리뷰 A", quality="xhigh", project_name="Work", outpost_id="a")
            store.create_thread(topic="리뷰 B", quality="xhigh", project_name="Work", outpost_id="b")
            with self.assertRaises(MODULE.AmbiguousThreadError):
                store.resolve("리뷰")
            with self.assertRaises(MODULE.UnknownThreadError):
                store.resolve("없는주제")

    def test_result_json_resolves_to_stored_thread(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MODULE.SessionStore(Path(temp) / "sessions.json")
            thread = store.create_thread(
                topic="후속",
                quality="xhigh",
                project_name="Work",
                outpost_id="turn-1",
            )
            store.mark_submitted(
                thread["threadId"],
                conversation_url="https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            )
            result = Path(temp) / "result.json"
            result.write_text(
                json.dumps({"threadId": thread["threadId"], "id": "turn-1"}),
                encoding="utf-8",
            )
            self.assertEqual(store.resolve(str(result))["threadId"], thread["threadId"])

    def test_dead_running_pid_is_listed_as_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MODULE.SessionStore(Path(temp) / "sessions.json")
            thread = store.create_thread(
                topic="죽은 프로세스",
                quality="xhigh",
                project_name="Work",
                outpost_id="turn-1",
                pid=99999999,
            )
            listed = store.listed_threads()
            self.assertEqual(listed[0]["threadId"], thread["threadId"])
            self.assertEqual(listed[0]["status"], "failed")

    def test_same_thread_lock_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = MODULE.SessionStore(Path(temp) / "sessions.json")
            thread = store.create_thread(
                topic="락",
                quality="xhigh",
                project_name="Work",
                outpost_id="turn-1",
            )
            with store.thread_lock(thread["threadId"]):
                with self.assertRaises(MODULE.ThreadBusyError):
                    with store.thread_lock(thread["threadId"]):
                        pass

    def test_cli_list_and_show(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "sessions.json"
            store = MODULE.SessionStore(path)
            thread = store.create_thread(
                topic="목록",
                quality="pro",
                project_name="Work",
                outpost_id="turn-1",
                pid=os.getpid(),
            )
            self.assertEqual(
                MODULE.main(["list", "--sessions-file", str(path)]),
                0,
            )
            self.assertEqual(
                MODULE.main(["show", thread["threadId"], "--sessions-file", str(path), "--json"]),
                0,
            )


if __name__ == "__main__":
    unittest.main()
