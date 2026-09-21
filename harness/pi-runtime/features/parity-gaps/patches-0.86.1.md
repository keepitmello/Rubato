# 0.85.1 → 0.86.1 패치 재판정

엔진 핀을 0.86.1로 올리며 이 feature의 깨진 패치를 판정했다. 깨진 이유는 두 가지뿐이다 —
pristine 파일이 바뀐 것(hash-only)과 앵커가 사라진 것(anchor-dead). 후자는 같은 의도를
새 소스에 다시 걸었고(re-cut), 업스트림이 같은 일을 하게 된 단계는 지웠다(delete).

`preimageSha256`은 설치된 0.86.1 pristine 파일에서 다시 기록했고, `version`은 0.86.1이다.
0.85.1 대조 원본은 npm tarball이다 — `~/.rubato-pi/stock-engine.previous`는 이미 패치가
걸린 staged 트리라 원본이 아니다.

| 패치 | 판정 | 사유 |
|---|---|---|
| `dist/utils/overflow.js` | re-cut | 0.86.1이 Cerebras의 bodyless 패턴을 `OVERFLOW_PATTERNS` 밖으로 빼서 앵커가 죽었다. 우리가 더하는 세 패턴(`conversation is too long`, `please try a shorter message`, `requested context length is too large/long`)은 업스트림이 새로 넣은 z.ai 패턴이 덮지 않으므로 목록 끝에 다시 걸었다. Case 2의 `cacheRead` 제외는 그대로 맞는다. |
| `dist/api/google-shared.js` | keep | `model.input.includes(\"image\")` 앵커 그대로(0.86.1의 thinking level·transcript 변경은 다른 구간이다). |
| `dist/api/openai-responses.js` | keep | `prompt_cache_options.ttl` 반환 앵커 그대로. 업스트림은 long 보존 경로만 30m으로 두고, 우리 패치는 그 외 경로도 30m으로 고정한다. |
