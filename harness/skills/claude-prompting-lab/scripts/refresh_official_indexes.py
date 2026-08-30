#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import argparse
import re
import urllib.request

SOURCES = {
    "anthropic-platform-llms.txt": "https://platform.claude.com/llms.txt",
    "claude-code-llms.txt": "https://code.claude.com/docs/llms.txt",
}

KEYWORDS = re.compile(
    r"prompt|model|thinking|effort|context|memory|compaction|tool|skill|agent|eval|guardrail|"
    r"hallucination|jailbreak|injection|system|subagent|structured|citation|multilingual",
    re.I,
)


def download(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "claude-prompting-lab/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh official Anthropic documentation indexes")
    parser.add_argument("--out-dir", default="sources/refreshed")
    args = parser.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    for name, url in SOURCES.items():
        text = download(url)
        (out / name).write_text(text, encoding="utf-8")
        relevant = [line for line in text.splitlines() if line.startswith("- [") and KEYWORDS.search(line)]
        (out / name.replace(".txt", "-prompt-relevant.txt")).write_text("\n".join(relevant) + "\n", encoding="utf-8")
        print(f"{name}: {len(text.splitlines())} lines, {len(relevant)} prompt-relevant links")

    print("Review diffs before changing model-specific instructions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
