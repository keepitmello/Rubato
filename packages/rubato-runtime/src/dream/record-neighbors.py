"""Three nearest records in this store, using only vectors msearch has already paid for.

Use each record's opening and first section (normally its conclusion); skip stale or
absent vectors, including when a trial has checked out a different version of a record.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import redis

sys.path.insert(0, sys.argv[1])
from msearch_config import HASH_PREFIX, KEY_PREFIX, MEMORY_ROOT, REDIS_URL


def nearest(worktree, repo, paths):
    client = redis.Redis.from_url(REDIS_URL, socket_connect_timeout=1, socket_timeout=2)
    prefix = repo.resolve().relative_to(MEMORY_ROOT.resolve())
    pipe = client.pipeline(transaction=False)
    for path in paths:
        key = hashlib.sha1((prefix / path).as_posix().encode()).hexdigest()[:16]
        pipe.get(HASH_PREFIX + key)
        for part in ("0", "1", "1-0"):
            pipe.hmget(f"{KEY_PREFIX}{key}:{part}", "file_path", "vector")
    answers = iter(pipe.execute())
    names, vectors = [], []
    for path in paths:
        fingerprint = next(answers)
        chunks = [next(answers) for _ in range(3)]
        digest = hashlib.sha256((worktree / path).read_bytes()).hexdigest().encode()
        if not fingerprint or fingerprint.split(b":")[-1] != digest:
            continue
        parts = [np.frombuffer(data, dtype="<f4") for location, data in chunks
                 if data and location == str(repo / path).encode()]
        if not parts:
            continue
        vector = np.mean(parts, axis=0)
        norm = np.linalg.norm(vector)
        if norm > 0:
            names.append(path)
            vectors.append(vector / norm)
    if not vectors:
        return {}
    matrix = np.stack(vectors)
    result = {}
    for i, name in enumerate(names):
        scores = matrix @ matrix[i]
        scores[i] = -np.inf
        result[name] = [names[j] for j in np.argsort(-scores)[:min(3, len(names) - 1)]]
    return result


if __name__ == "__main__":
    print(json.dumps(nearest(Path.cwd(), Path(sys.argv[2]), json.load(sys.stdin))))
