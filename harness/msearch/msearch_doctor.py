#!/usr/bin/env python3
"""msearch 가 돌 수 있는 상태인지 보고, 아니면 다음 한 걸음을 알려준다.

검색은 Redis Stack(RediSearch 모듈)과 OpenAI 임베딩 위에서 돈다. 둘 중 하나만 없어도
색인이 못 서고, 색인이 없으면 검색은 조용히 0건을 준다 — 그 침묵이 "기억이 없음"인지
"설치가 안 됨"인지 구분되지 않는 게 제일 나쁘다. 그래서 진단을 분리해 둔다.

  python3 msearch_doctor.py
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import msearch_config as config
import msearch_env

OK = "ok"
MISSING = "missing"


def _print(status: str, label: str, detail: str = "") -> None:
    mark = {"ok": "  ok  ", "warn": " warn ", "fail": " fail "}[status]
    line = f"[{mark}] {label}"
    if detail:
        line += f"\n         {detail}"
    print(line)


def check_python_deps() -> list[str]:
    mismatches = msearch_env.problems()
    if mismatches:
        _print("fail", "python 환경이 requirements.lock 과 다름", "\n         ".join(mismatches))
    else:
        _print("ok", "python 환경 (requirements.lock)")
    return mismatches


def check_java() -> bool:
    expected = msearch_env.runtime_versions()["JAVA_MAJOR"]
    try:
        output = subprocess.run(
            ["java", "-version"], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError) as error:
        _print("fail", "Java 없음", f"JDK {expected} 필요: {error}")
        return False
    match = re.search(r'version "(\d+)', output.stderr or output.stdout)
    actual = match.group(1) if match else ""
    if actual != expected:
        _print("fail", f"Java {actual or '알 수 없음'}", f"JDK {expected} 필요")
        return False
    _print("ok", f"Java {actual} (KoNLPy)")
    return True


def check_redis() -> bool:
    try:
        import redis
    except ImportError:
        _print("fail", "redis 연결", "redis 패키지부터 설치")
        return False

    try:
        client = redis.from_url(config.REDIS_URL)
        client.ping()
    except Exception as error:
        _print(
            "fail",
            f"redis 연결 ({config.REDIS_URL})",
            "Redis Stack 이 필요하다 (RediSearch 모듈 포함, 일반 redis 로는 안 된다):\n"
            "           Redis 8.4.0 + Search 8.4.2 기준은 harness/msearch/README.md 참고\n"
            f"         원인: {error}",
        )
        return False

    try:
        modules = {m[b"name"].decode() if isinstance(m, dict) else str(m) for m in client.module_list()}
    except Exception:
        modules = set()
    has_search = any("search" in name.lower() for name in modules)
    if not has_search:
        _print(
            "fail",
            "RediSearch 모듈",
            "붙은 redis 에 검색 모듈이 없다. redis-stack 이미지로 띄워야 한다.",
        )
        return False

    expected = msearch_env.runtime_versions()
    server_info = client.info("server")
    module_info = client.info("modules")
    actual_redis = str(server_info.get("redis_version", ""))
    actual_search = str(module_info.get("search_version", ""))
    if actual_redis != expected["REDIS_VERSION"] or actual_search != expected["SEARCH_VERSION"]:
        _print(
            "fail",
            "redis 런타임이 runtime.lock 과 다름",
            f"Redis {actual_redis or '알 수 없음'} (필요 {expected['REDIS_VERSION']})\n"
            f"         Search {actual_search or '알 수 없음'} (필요 {expected['SEARCH_VERSION']})",
        )
        return False

    _print("ok", f"Redis {actual_redis} + Search {actual_search} ({config.REDIS_URL})")
    return True


def check_api_key() -> bool:
    env_file = config.STATE_DIR / ".env"
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key and env_file.is_file():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if key:
        _print("ok", "OPENAI_API_KEY")
        return True
    _print(
        "fail",
        "OPENAI_API_KEY 없음",
        f"export OPENAI_API_KEY=sk-...   또는\n         echo 'OPENAI_API_KEY=sk-...' >> {env_file}",
    )
    return False


def check_corpus() -> int:
    root = config.MEMORY_ROOT
    if not root.exists():
        _print("fail", f"색인 대상 없음 ({root})", "MSEARCH_ROOT 로 다른 경로를 지정할 수 있다.")
        return 0
    count = sum(1 for path in root.rglob("*.md") if "/.git/" not in f"/{path}/" and path.is_file())
    if count == 0:
        _print("warn", f"색인 대상 0개 ({root})", "메모리에 기록이 쌓이면 채워진다.")
    else:
        _print("ok", f"색인 대상 {count}개 마크다운 ({root})")
    return count


def check_index(redis_ready: bool) -> bool:
    if not redis_ready:
        return False
    try:
        import redis

        client = redis.from_url(config.REDIS_URL)
        info = client.ft(config.INDEX_NAME).info()
    except Exception:
        _print("warn", f"색인 '{config.INDEX_NAME}' 아직 없음", "python3 memory-index.py 로 만든다.")
        return False
    docs = 0
    try:
        if isinstance(info, dict):
            docs = int(info.get("num_docs", 0) or 0)
        else:
            pairs = {info[i]: info[i + 1] for i in range(0, len(info) - 1, 2)}
            raw = pairs.get(b"num_docs") or pairs.get("num_docs") or 0
            docs = int(raw)
    except Exception:
        docs = 0
    if docs == 0:
        _print("warn", f"색인 '{config.INDEX_NAME}' 비어 있음", "python3 memory-index.py 로 채운다.")
        return False
    _print("ok", f"색인 '{config.INDEX_NAME}' 문서 {docs}개")
    return True


def main() -> int:
    print("msearch 상태\n")
    print(config.describe())
    print()

    missing = check_python_deps()
    java_ready = check_java()
    redis_ready = check_redis()
    key_ready = check_api_key()
    corpus = check_corpus()
    indexed = check_index(redis_ready)

    print()
    if missing or not java_ready or not redis_ready or not key_ready:
        print("아직 못 돈다. 위의 fail 부터 처리하면 된다.")
        return 1
    if not indexed:
        if corpus == 0:
            print("설치는 끝났다. 색인할 기록이 쌓이면 그때 memory-index.py 를 돌린다.")
            return 0
        print("설치는 끝났다. 이제 색인을 만든다:  python3 memory-index.py")
        return 0
    print("준비 끝. 바로 검색하면 된다:  msearch '찾을 내용'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
