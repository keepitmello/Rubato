#!/usr/bin/env python3
"""fx/rubato 세션 트랜스크립트 복원.

압축(compaction)으로 초반 맥락이 날아간 세션에서, 디스크에 남은 원본
이벤트 로그를 읽어 대화를 되살린다. 컨텍스트에서 사라진 것이지 디스크에서
사라진 것이 아니기 때문에 복원이 가능하다.

세션 저장 구조가 두 가지라 둘 다 처리한다:

  1. 미압축 — events.jsonl 에 kind="history_turn_committed" 가 턴마다 하나씩.
  2. 압축됨 — 전체 상태가 통째로 교체되어 kind="state_replacement_chunk" 의
     payload.base64 조각으로 흩어진다. 조각을 인덱스 순으로 이어붙인 뒤
     한 번에 디코드해야 한다(조각별 디코드는 경계에서 깨진다).

압축본은 4MB 근처에서 JSON 이 잘려 있는 경우가 있어 json.loads 가 실패한다.
그래서 파싱은 항상 정규식 폴백을 가진다.

사용법:
    session-transcript.py                     # 최근 세션 목록
    session-transcript.py <id|prefix>         # 유저 발화만 (기본)
    session-transcript.py <id> --full         # 유저+어시스턴트
    session-transcript.py <id> --children     # 자식 세션과 각 브리프 첫 줄
    session-transcript.py <id> --grep 깨우기   # 해당 문자열 포함 턴만
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

SESSIONS = Path(os.environ.get("FX_HOME", Path.home() / ".fx")) / "sessions"


# ---------------------------------------------------------------- 세션 찾기

def resolve(token: str) -> Path:
    """세션 id, 접두사, 또는 디렉터리 경로를 세션 디렉터리로 푼다."""
    direct = Path(token)
    if direct.is_dir() and (direct / "session.json").exists():
        return direct

    hits = [d for d in SESSIONS.iterdir() if d.is_dir() and d.name.startswith(token)]
    if not hits:
        # id 끝 해시로도 찾아본다.
        hits = [d for d in SESSIONS.iterdir() if d.is_dir() and token in d.name]
    if not hits:
        sys.exit(f"세션을 못 찾았어: {token}")
    if len(hits) > 1:
        names = "\n  ".join(h.name for h in hits)
        sys.exit(f"접두사가 여러 세션에 걸려:\n  {names}")
    return hits[0]


def meta(session_dir: Path) -> dict:
    try:
        return json.loads((session_dir / "session.json").read_text())
    except Exception:
        return {}


def list_sessions(limit: int = 25) -> None:
    rows = []
    for d in SESSIONS.iterdir():
        if not d.is_dir() or d.name == "latest":
            continue
        m = meta(d)
        if not m:
            continue
        rows.append((m.get("updated_at_ms", 0), d, m))
    rows.sort(reverse=True)

    print(f"{'updated':<17} {'turns':>5}  {'model':<26} id")
    for updated, d, m in rows[:limit]:
        when = datetime.fromtimestamp(updated / 1000).strftime("%m/%d %H:%M") if updated else "?"
        model = (m.get("preferences") or {}).get("model", "?")
        # history_len 은 압축 후 1 로 떨어지므로 그대로는 못 믿는다.
        turns = m.get("history_len", "?")
        print(f"{when:<17} {turns:>5}  {model:<26} {d.name}")


# ---------------------------------------------------------------- 상태 복원

def read_events(session_dir: Path):
    path = session_dir / "events.jsonl"
    if not path.exists():
        return
    with path.open("r", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except Exception:
                continue


def rebuild_replacement(session_dir: Path) -> str | None:
    """압축된 세션의 최신 상태 스냅샷을 텍스트로 되살린다.

    조각을 base64 '문자열' 상태로 먼저 이어붙인 뒤 한 번에 디코드한다.
    조각마다 따로 디코드하면 4의 배수가 아닌 경계에서 바이트가 깨진다.
    """
    chunks: dict[str, dict[int, str]] = {}
    committed: list[str] = []

    for e in read_events(session_dir):
        kind = e.get("kind")
        p = e.get("payload") or {}
        if kind == "state_replacement_chunk":
            rid = p.get("replacement_id")
            chunks.setdefault(rid, {})[p.get("chunk_index", 0)] = p.get("base64", "")
        elif kind == "state_replacement_committed":
            committed.append(p.get("replacement_id"))

    if not chunks:
        return None

    rid = committed[-1] if committed else max(chunks, key=lambda k: len(chunks[k]))
    joined = "".join(chunks[rid][i] for i in sorted(chunks[rid]))
    return base64.b64decode(joined).decode("utf-8", errors="replace")


def load_state_text(session_dir: Path) -> str | None:
    """압축 스냅샷 우선, 없으면 checkpoint.json."""
    text = rebuild_replacement(session_dir)
    if text:
        return text
    cp = session_dir / "checkpoint.json"
    if cp.exists():
        return cp.read_bytes().decode("utf-8", errors="replace")
    return None


# ---------------------------------------------------------------- 턴 추출

_DECODER = json.JSONDecoder()


def _decode_at(text: str, pos: int) -> str | None:
    """text[pos] 부터 시작하는 JSON 문자열 하나를 푼다."""
    try:
        value, _ = _DECODER.raw_decode(text, pos)
        return value if isinstance(value, str) else None
    except Exception:
        return None


def turns_from_events(session_dir: Path) -> list[tuple[str, str]]:
    """미압축 세션: history_turn_committed 에서 (user, assistant) 쌍."""
    out = []
    for e in read_events(session_dir):
        if e.get("kind") != "history_turn_committed":
            continue
        blob = json.dumps(e, ensure_ascii=False)
        user = assistant = ""
        i = blob.find('"user":{"text":')
        if i >= 0:
            user = _decode_at(blob, i + len('"user":{"text":')) or ""
        j = blob.find('"assistant":')
        if j >= 0:
            assistant = _decode_at(blob, j + len('"assistant":')) or ""
        if user or assistant:
            out.append((user, assistant))
    return out


def turns_from_state(text: str) -> list[tuple[str, str]]:
    """압축 스냅샷: history 배열을 훑는다.

    json.loads 가 되면 그걸 쓰고, 잘려 있으면 정규식으로 같은 걸 뽑는다.
    """
    try:
        doc = json.loads(text)
        out = []
        for item in doc.get("history", []):
            user = ((item.get("user") or {}).get("text")) or ""
            assistant = item.get("assistant") or ""
            if user or assistant:
                out.append((user, assistant))
        if out:
            return out
    except Exception:
        pass

    # 폴백 — 스냅샷이 잘렸을 때.
    out = []
    for m in re.finditer(r'"user":\{"text":', text):
        user = _decode_at(text, m.end()) or ""
        tail = text[m.end():m.end() + 200000]
        k = tail.find('"assistant":')
        assistant = _decode_at(tail, k + len('"assistant":')) if k >= 0 else ""
        out.append((user, assistant or ""))
    return out


def transcript(session_dir: Path) -> list[tuple[str, str]]:
    turns = turns_from_events(session_dir)
    if turns:
        return turns
    text = load_state_text(session_dir)
    return turns_from_state(text) if text else []


# ---------------------------------------------------------------- 자식 세션

def children(session_dir: Path) -> list[tuple[str, Path | None]]:
    """create-operations.json 의 child_id 를 세션 디렉터리로 잇는다."""
    ops = session_dir / "subagent" / "create-operations.json"
    if not ops.exists():
        return []
    try:
        doc = json.loads(ops.read_text())
    except Exception:
        return []

    out = []
    for entry in doc.get("entries", []):
        cid = entry.get("child_id")
        if not cid:
            continue
        d = SESSIONS / cid
        out.append((cid, d if d.is_dir() else None))
    return out


def first_brief(session_dir: Path, width: int = 200) -> str:
    turns = transcript(session_dir)
    if not turns:
        return "(빈 세션 — 모델 오류로 죽었을 수 있음)"
    return turns[0][0].replace("\n", " | ")[:width]


# ---------------------------------------------------------------- 출력

def render(turns, full: bool, grep: str | None, width: int) -> None:
    shown = 0
    for i, (user, assistant) in enumerate(turns, 1):
        if grep and grep not in user and grep not in assistant:
            continue
        shown += 1
        body = user if width <= 0 else user.replace("\n", " | ")[:width]
        print(f"[{i}] {body}")
        if full and assistant:
            text = assistant if width <= 0 else assistant.replace("\n", " | ")[:width]
            print(f"    -> {text}")
            print()
    if grep:
        print(f"\n{shown}/{len(turns)} 턴이 '{grep}' 를 포함해.")


def main() -> None:
    ap = argparse.ArgumentParser(description="fx/rubato 세션 트랜스크립트 복원")
    ap.add_argument("session", nargs="?", help="세션 id 또는 접두사. 없으면 목록.")
    ap.add_argument("--full", action="store_true", help="어시스턴트 응답도 출력")
    ap.add_argument("--children", action="store_true", help="자식 세션과 브리프 첫 줄")
    ap.add_argument("--grep", help="해당 문자열이 든 턴만")
    ap.add_argument("--width", type=int, default=200, help="줄당 최대 글자수. 0이면 전문.")
    args = ap.parse_args()

    if not SESSIONS.is_dir():
        sys.exit(f"세션 디렉터리가 없어: {SESSIONS}")

    if not args.session:
        list_sessions()
        return

    d = resolve(args.session)
    m = meta(d)
    model = (m.get("preferences") or {}).get("model", "?")
    print(f"# {d.name}")
    print(f"# model={model} workspace={m.get('workspace_root','?')}")

    if args.children:
        kids = children(d)
        print(f"# 에이전트 {len(kids)}개\n")
        for cid, cdir in kids:
            when = datetime.fromtimestamp((cdir / "session.json").stat().st_mtime).strftime("%m/%d %H:%M") if cdir else "?"
            cmodel = (meta(cdir).get("preferences") or {}).get("model", "?") if cdir else "?"
            print(f"{cid[:13]}  {when}  {cmodel}")
            print(f"  {first_brief(cdir) if cdir else '(세션 디렉터리 없음)'}")
            print()
        return

    turns = transcript(d)
    print(f"# 턴 {len(turns)}개\n")
    render(turns, args.full, args.grep, args.width)


if __name__ == "__main__":
    main()
