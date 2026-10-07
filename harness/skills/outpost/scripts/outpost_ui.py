"""ChatGPT screen map and the heal loop that rewrites it.

Every name and selector the send path looks up on chatgpt.com lives in one map.
The defaults below are what the code last saw; `~/.codex/outpost-ui.json` holds
what doctor learned since. When a pre-submit step cannot find its control, the
heal loop shows a model the failing page and lets it rewrite the saved map —
only the map, never code — and keeps a rewrite only when the same send path,
rehearsed again, gets further.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Callable


DEFAULT_UI_MAP_PATH = Path.home() / ".codex" / "outpost-ui.json"
LEGACY_PICKER_PATH = Path.home() / ".codex" / "outpost-picker.json"
DEFAULT_HEAL_MODEL = "b-ai/deepseek-v4.1-flash"
# A screen change can break several steps at once and each fix only reveals
# the next broken step, so the loop gives up on a step after a few tries that
# get no further, not after a fixed total.
HEAL_TRIES_PER_STEP = 3
HEAL_MAX_TRIES = 12
# A reply normally takes 20-60 s; a call that runs longer has stalled, and the
# loop's next try is cheaper than waiting it out.
HEAL_TIMEOUT_SECONDS = 120
ALLOWED_MODEL_RADIOS = ("GPT-6",)

# kind: css = CSS selectors tried together; names = accessible names tried in
# order; labels = slider stop names per quality; text = one string.
UI_KEYS: dict[str, tuple[str, str]] = {
    "composer": ("css", "the prompt editor (contenteditable) on project home and in a conversation"),
    "projectComposerLabels": (
        "names",
        "aria-label of the project-home prompt editor; {project} is replaced by the project name",
    ),
    "chatToggle": ("css", "banner toggle button that selects the Chat surface (has aria-checked)"),
    "workToggle": ("css", "banner toggle button that selects the Work surface (has aria-checked)"),
    "tierButtonNames": (
        "names",
        "accessible name of the composer button that opens the model/tier menu",
    ),
    "tierSliderNames": ("names", "accessible name of the menuitem that holds the tier slider"),
    "tierPositionPattern": (
        "text",
        "JS regex over the snapshot tree reading the slider status; named groups label, total, index",
    ),
    "tierLabels": ("labels", "slider stop name per quality: pro -> the Pro stop, xhigh -> the stop just below Pro"),
    "modelMenuNames": ("names", "accessible name of the menuitem that opens the model submenu"),
    "modelRadio": ("text", "menuitemradio text of the pinned GPT-6 family"),
    "fileInput": ("css", "<input type=file> of the composer that accepts any file (not images only)"),
    "sendButton": ("css", "the composer send (submit) button; an enabled-state filter is appended by code"),
    "stopButton": ("css", "button shown while a reply is streaming"),
    "copyResponse": ("css", "copy button under a finished reply"),
    "userMessage": ("css", "a user turn in the conversation"),
    "assistantMessage": ("css", "an assistant turn in the conversation"),
}

# Which keys each send step reads, so the heal model looks at the right ones.
STAGE_KEYS: dict[str, tuple[str, ...]] = {
    "wait-project-composer": ("composer", "projectComposerLabels"),
    "wait-conversation-composer": ("composer",),
    "select-chat-surface": ("chatToggle", "workToggle", "composer", "projectComposerLabels"),
    "select-tier": ("tierButtonNames",),
    "open-tier-slider": ("tierSliderNames",),
    "read-tier": ("tierPositionPattern",),
    "pick-tier": ("tierLabels", "tierPositionPattern"),
    "open-model-menu": ("modelMenuNames",),
    "verify-model": ("modelRadio",),
    "fill-composer": ("composer", "projectComposerLabels"),
    "attach-packet": ("fileInput",),
    "ready-to-send": ("sendButton",),
}

DEFAULT_UI_MAP: dict[str, Any] = {
    "composer": [
        '#prompt-textarea[contenteditable="true"]',
        '.ProseMirror[contenteditable="true"]',
    ],
    "projectComposerLabels": ["{project}의 새 채팅", "{project}에서 새 채팅"],
    "chatToggle": ['button[data-tpp-toggle-value="chatgpt"]'],
    "workToggle": ['button[data-tpp-toggle-value="work"]'],
    "tierButtonNames": [
        # The picker button's own aria-label names it whatever tier is selected.
        "ChatGPT 모델 선택",
        "추론 수준",
        "즉시",
        "중간",
        "높음",
        "매우 높음",
        "Pro",
        "Instant",
        "Medium",
        "High",
        "Extra High",
    ],
    "tierSliderNames": ["파워", "성능"],
    "tierPositionPattern": r'(?<label>[^\n"]+), (?<total>\d+)개 중 (?<index>\d+)번째',
    "tierLabels": {"pro": ["Pro"], "xhigh": ["Extra High", "매우 높음"]},
    "modelMenuNames": ["모델 선택"],
    "modelRadio": "GPT-6",
    "fileInput": [
        "#upload-files",
        'form input[type="file"]:not([accept])',
        'form input[type="file"][accept=""]',
    ],
    "sendButton": [
        "#composer-submit-button",
        'form button[type="submit"][aria-label="보내기"]',
    ],
    "stopButton": [
        'button[data-testid="stop-button"]',
        'button[aria-label*="중지"]',
        'button[aria-label*="Stop"]',
    ],
    "copyResponse": ['button[aria-label="응답 복사"]', 'button[aria-label="Copy response"]'],
    "userMessage": ['[data-message-author-role="user"]'],
    "assistantMessage": ['[data-message-author-role="assistant"]'],
}


def ui_map_path() -> Path:
    return Path(os.environ.get("OUTPOST_UI_MAP_PATH") or DEFAULT_UI_MAP_PATH)


def _norm(value: Any) -> str:
    return " ".join(str(value).split())


def _union(first: list[str], then: list[str]) -> list[str]:
    merged: list[str] = []
    for item in [*first, *then]:
        text = _norm(item)
        if text and text not in merged:
            merged.append(text)
    return merged


def _pattern_problem(pattern: str) -> str | None:
    for group in ("label", "total", "index"):
        if f"(?<{group}>" not in pattern:
            return f"tierPositionPattern needs the named group {group}"
    try:
        re.compile(re.sub(r"\(\?<(label|total|index)>", r"(?P<\1>", pattern))
    except re.error as exc:
        return f"tierPositionPattern does not compile: {exc}"
    return None


def validate_overlay(raw: Any) -> tuple[dict[str, Any], list[str]]:
    """Keep the well-formed, safe part of a proposed map; name what was dropped."""
    if not isinstance(raw, dict):
        return {}, ["the map must be a JSON object"]
    clean: dict[str, Any] = {}
    errors: list[str] = []
    for key, value in raw.items():
        if key not in UI_KEYS:
            errors.append(f"unknown key {key}")
            continue
        kind = UI_KEYS[key][0]
        if kind in {"css", "names"}:
            items = value if isinstance(value, list) else [value]
            if not all(isinstance(item, str) for item in items):
                errors.append(f"{key} must be a list of strings")
                continue
            items = [item.strip() for item in items if item.strip() and "\n" not in item and len(item) < 300]
            if not items:
                errors.append(f"{key} is empty")
                continue
            clean[key] = items
        elif kind == "text":
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{key} must be a non-empty string")
                continue
            text = value.strip()
            if key == "modelRadio" and text not in ALLOWED_MODEL_RADIOS:
                errors.append(f"modelRadio may not be {text}")
                continue
            if key == "tierPositionPattern":
                problem = _pattern_problem(text)
                if problem:
                    errors.append(problem)
                    continue
            clean[key] = text
        elif kind == "labels":
            if not isinstance(value, dict):
                errors.append("tierLabels must map quality to a list of names")
                continue
            labels: dict[str, list[str]] = {}
            for quality, names in value.items():
                if quality not in DEFAULT_UI_MAP["tierLabels"] or not isinstance(names, list):
                    errors.append(f"tierLabels.{quality} is not a known quality list")
                    continue
                names = [_norm(name) for name in names if isinstance(name, str) and _norm(name)]
                if names:
                    labels[quality] = names
            # A wrong xhigh label that lands on Pro would spend Pro quota on a
            # plumbing send, so no stop may name both qualities and xhigh never
            # names a Pro stop.
            if any(re.search(r"\bpro\b", name, re.I) for name in labels.get("xhigh", [])):
                errors.append("tierLabels.xhigh may not name a Pro stop")
                labels.pop("xhigh", None)
            if labels:
                clean["tierLabels"] = labels
    return clean, errors


def _pending_path(path: Path) -> Path:
    return path.with_name(path.name + ".heal-pending")


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _restore_interrupted_heal(path: Path) -> None:
    """A heal writes each unverified candidate into the map; if its process died
    mid-check, put back the last map it had verified."""
    pending = _pending_path(path)
    try:
        record = json.loads(pending.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if _pid_alive(int(record.get("pid") or 0)):
        return
    write_overlay(dict(record.get("verified") or {}), path)
    pending.unlink(missing_ok=True)


def read_overlay(path: Path | None = None) -> dict[str, Any]:
    path = path or ui_map_path()
    _restore_interrupted_heal(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = None
    if data is None and path == DEFAULT_UI_MAP_PATH and LEGACY_PICKER_PATH.is_file():
        try:
            legacy = json.loads(LEGACY_PICKER_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            legacy = {}
        data = {
            "tierButtonNames": list(legacy.get("tierAliases") or []),
            "modelRadio": legacy.get("modelRadio") or "",
        }
    clean, _ = validate_overlay(data or {})
    return clean


def write_overlay(overlay: dict[str, Any], path: Path | None = None) -> Path:
    path = path or ui_map_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(overlay, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def merge(overlay: dict[str, Any]) -> dict[str, Any]:
    """Saved names first, then the defaults: a learned name wins, an old one still works."""
    merged: dict[str, Any] = {}
    for key, (kind, _) in UI_KEYS.items():
        default = DEFAULT_UI_MAP[key]
        value = overlay.get(key)
        if kind in {"css", "names"}:
            merged[key] = _union(list(value or []), list(default))
        elif kind == "text":
            merged[key] = value or default
        else:
            labels = dict(value or {})
            merged[key] = {
                quality: _union(list(labels.get(quality) or []), list(names))
                for quality, names in default.items()
            }
    return merged


def load_ui_map(path: Path | None = None) -> dict[str, Any]:
    return merge(read_overlay(path))


def css(selectors: list[str]) -> str:
    return ", ".join(selectors)


# ---------------------------------------------------------------- heal loop


def _heal_prompt(
    *,
    stage: str,
    stage_hint: str,
    detail: str,
    diag: dict[str, Any] | None,
    overlay: dict[str, Any],
    history: list[str],
) -> str:
    keys = "\n".join(f"- {key} ({kind}): {meaning}" for key, (kind, meaning) in UI_KEYS.items())
    effective = json.dumps(merge(overlay), ensure_ascii=False, indent=1)
    diag = diag or {}
    tree = str(diag.get("tree") or "(no snapshot captured)")
    outline = json.dumps(diag.get("outline") or [], ensure_ascii=False)
    tried = "\n".join(f"- {line}" for line in history) or "- (none)"
    return f"""You maintain the locator map a script uses to drive chatgpt.com in a browser.
ChatGPT changed its page and one step of the script can no longer find its control.

Failed step: {stage} ({stage_hint})
Error: {detail}
Page URL: {diag.get("url") or "-"}  title: {diag.get("title") or "-"}

Keys this step reads: {", ".join(STAGE_KEYS.get(stage, ())) or "-"}

How the script uses the map:
- css keys: joined with ", " into one Playwright CSS selector.
- The project-home composer is found by appending `[aria-label="<label>"]` to
  each composer selector, so one composer selector and one label must both
  match the same element (an id that no longer exists fails the whole lookup).
- names keys: exact accessible names, as they appear in the snapshot tree below
  (`- button "NAME" [ref=e12]`, `- menuitem "NAME"`), tried in order.
- tierLabels: the slider status line reads like `status: "Extra High, 5개 중 4번째."`;
  the label part must equal one listed name for that quality.
- modelRadio: the text of a `menuitemradio` in the model submenu.

Map keys:
{keys}

Current map (saved names first, built-in defaults after):
{effective}

Accessibility snapshot of the page at the failure (interactive elements):
{tree}

DOM outline of the composer form, open menus and toggles (hidden inputs included):
{outline}

Earlier proposals for this failure that did not get further:
{tried}

Return ONLY one JSON object with the keys you change. Each value replaces the
saved value for that key; list the name or selector that matches the page now
first. Use only names and selectors you can see above. Do not invent controls.
Never put a Pro stop under tierLabels.xhigh and never select a model named Sol.
If nothing in the map can fix this step, return {{}}."""


def _first_json_object(text: str) -> Any:
    """The last complete JSON object in a reply: the answer after any preamble."""
    decoder = json.JSONDecoder()
    found = None
    index = text.find("{")
    while index != -1:
        try:
            value, end = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            index = text.find("{", index + 1)
            continue
        if isinstance(value, dict):
            found = value
        index = text.find("{", end)
    return found


def ask_heal_model(prompt: str) -> str:
    model = os.environ.get("OUTPOST_HEAL_MODEL") or DEFAULT_HEAL_MODEL
    command = [
        os.environ.get("OUTPOST_HEAL_BIN") or "rubato",
        "-p",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--model",
        model,
    ]
    with tempfile.TemporaryDirectory(prefix="outpost-heal-") as work:
        prompt_file = Path(work) / "prompt.md"
        prompt_file.write_text(prompt, encoding="utf-8")
        completed = subprocess.run(
            [*command, f"@{prompt_file}", "Follow the instructions in the attached file."],
            cwd=work,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=HEAL_TIMEOUT_SECONDS,
            check=False,
        )
    return completed.stdout or ""


def heal(
    *,
    failure: dict[str, Any],
    verify: Callable[[], dict[str, Any]],
    stage_rank: Callable[[str], int],
    stage_hint: Callable[[str], str],
    log: Callable[[str], None],
    ask: Callable[[str], str] = ask_heal_model,
    tries_per_step: int = HEAL_TRIES_PER_STEP,
    max_tries: int = HEAL_MAX_TRIES,
) -> dict[str, Any]:
    """Rewrite the saved map until `verify` passes; keep only rewrites that get further.

    `failure` and every `verify()` result carry ok, stage, detail and diag.
    Returns {"ok", "attempts", "result", "overlay"}.
    """
    kept = read_overlay()
    pending = _pending_path(ui_map_path())
    current = failure
    history: list[str] = []
    stale = 0
    attempt = 0
    while attempt < max_tries and stale < tries_per_step:
        attempt += 1
        stale += 1
        stage = str(current.get("stage") or "")
        prompt = _heal_prompt(
            stage=stage,
            stage_hint=stage_hint(stage),
            detail=str(current.get("detail") or ""),
            diag=current.get("diag"),
            overlay=kept,
            history=history,
        )
        try:
            answer = ask(prompt)
        except (OSError, subprocess.SubprocessError) as exc:
            log(f"OUTPOST_HEAL attempt={attempt} stage={stage} model call failed: {exc}")
            history.append(f"model call failed: {exc}")
            continue
        proposal, errors = validate_overlay(_first_json_object(answer))
        if errors:
            history.append("rejected: " + "; ".join(errors))
        if not proposal:
            said = " ".join(answer.split())[-240:]
            why = "; ".join(errors) or "no change"
            log(f"OUTPOST_HEAL attempt={attempt} stage={stage} no usable proposal ({why}): {said}")
            history.append("returned no usable change")
            continue
        candidate = {**kept, **proposal}
        pending.write_text(
            json.dumps({"pid": os.getpid(), "verified": kept}, ensure_ascii=False),
            encoding="utf-8",
        )
        write_overlay(candidate)
        try:
            result = verify()
        except BaseException:
            write_overlay(kept)
            pending.unlink(missing_ok=True)
            raise
        pending.unlink(missing_ok=True)
        new_stage = str(result.get("stage") or "")
        summary = json.dumps(proposal, ensure_ascii=False)
        if result.get("ok"):
            log(f"OUTPOST_HEAL attempt={attempt} stage={stage} fixed with {summary}")
            return {"ok": True, "attempts": attempt, "result": result, "overlay": candidate}
        if stage_rank(new_stage) > stage_rank(stage):
            log(
                f"OUTPOST_HEAL attempt={attempt} stage={stage} -> {new_stage} "
                f"got further with {summary}"
            )
            kept = candidate
            current = result
            history = []
            stale = 0
            continue
        write_overlay(kept)
        log(f"OUTPOST_HEAL attempt={attempt} stage={stage} no progress with {summary}")
        history.append(f"{summary} -> still failed at {new_stage}: {str(result.get('detail') or '')[:160]}")
        if result.get("diag"):
            current = {**current, "diag": result["diag"]}
    write_overlay(kept)
    return {"ok": False, "attempts": attempt, "result": current, "overlay": kept}
