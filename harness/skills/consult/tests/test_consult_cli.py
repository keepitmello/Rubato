from __future__ import annotations

import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "consult"
LOADER = importlib.machinery.SourceFileLoader("consult_cli_test", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConsultCliTest(unittest.TestCase):
    def test_send_infers_run_dir_and_output_paths(self) -> None:
        args = MODULE.parse_args(["send", "--quality", "xhigh", ".consult/foo/packet.md"])
        argv = MODULE.build_engine_argv("send", args)
        self.assertEqual(
            argv,
            [
                "--quality", "xhigh",
                "--packet", ".consult/foo/packet.md",
                "--response-output", ".consult/foo/response.md",
                "--json-output", ".consult/foo/result.json",
                "--stderr-output", ".consult/foo/stderr.log",
            ],
        )

    def test_positional_quality_and_thread_target(self) -> None:
        args = MODULE.parse_args(["send", "pro", "notes.md", "--to", "abcd1234"])
        argv = MODULE.build_engine_argv("send", args)
        self.assertIn("--quality", argv)
        self.assertEqual(argv[argv.index("--quality") + 1], "pro")
        self.assertEqual(argv[argv.index("--packet") + 1], "notes.md")
        self.assertEqual(argv[argv.index("--thread") + 1], "abcd1234")
        self.assertEqual(argv[argv.index("--response-output") + 1], ".consult/notes/response.md")

    def test_conversation_url_uses_continue_flag(self) -> None:
        args = MODULE.parse_args(
            [
                "send",
                "--quality",
                "xhigh",
                "p.md",
                "--to",
                "https://chatgpt.com/c/6a95625e-1f78-83e8-aa90-a49f982e36ef",
            ]
        )
        argv = MODULE.build_engine_argv("send", args)
        self.assertIn("--conversation-url", argv)
        self.assertNotIn("--thread", argv)

    def test_list_and_recover_stay_small(self) -> None:
        listed = MODULE.build_engine_argv(
            "list",
            MODULE.parse_args(["list", "--json"]),
        )
        self.assertEqual(listed, ["--list", "--limit", "20", "--json"])
        recovered = MODULE.build_engine_argv(
            "recover",
            MODULE.parse_args(["recover", ".consult/foo/result.json"]),
        )
        self.assertEqual(recovered[0], "--recover-from")
        self.assertEqual(recovered[1], ".consult/foo/result.json")
        self.assertIn(".consult/foo/response.md", recovered)

    def test_send_without_quality_fails_closed(self) -> None:
        args = MODULE.parse_args(["send", "packet.md"])
        with self.assertRaisesRegex(ValueError, "xhigh or pro"):
            MODULE.build_engine_argv("send", args)

    def test_main_dispatches_send_to_engine(self) -> None:
        with mock.patch.object(MODULE, "load_module") as load:
            runner = mock.Mock()
            runner.main.return_value = 0
            load.return_value = runner
            result = MODULE.main(["send", "xhigh", "packet.md"])
        self.assertEqual(result, 0)
        sent = runner.main.call_args.args[0]
        self.assertEqual(sent[:4], ["--quality", "xhigh", "--packet", "packet.md"])


if __name__ == "__main__":
    unittest.main()
