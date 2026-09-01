# Aside

Aside 피커의 Grok을 Rubato 세션과 같은 Cursor Connect 경로로 보낸다.
`rubato aside-cursor`가 localhost OpenAI 호환을 열고, 안쪽은
`AgentService/Run`(checkpoint 메아리 + RequestContext pin)다.

OpenCodex 루프백(`127.0.0.1:10100`)이 아니다. 그 경로는 full replay라
같은 53KB fixture에서 T2–T6 접두 히트 98.7–99.1%가 안 나온다.

## 다른 머신

1. Rubato를 설치하고 `rubato auth`로 Cursor가 연결돼 있는지 확인한다.
2. Aside를 한 번 실행해 `~/.aside/u/0/models.json`이 생기게 한다.
3. 설치한다.

```bash
rubato aside-cursor --install
```

로그인 시 기동되고, 죽으면 launchd(`com.keepitmello.rubato.aside-cursor`)가
다시 올린다. 기동된 프로세스가 `~/.aside/u/0/models.json`을 잠근다.

- `providers.cursor` → `http://127.0.0.1:18788/v1`, key `rubato-cursor`
- 피커에 `cursor/grok-4.6`과 `cursor/grok-4.6-fast`가 없으면 넣는다.
  둘 다 pinned `cursor-grok-4.6`으로 접힌다.
- xAI `grok-4.6`은 `https://api.x.ai/v1` 기본 차로다. 예전에 localhost
  `/xai`로 묶여 있으면 공식 upstream으로 되돌린다.

4. Aside를 다시 열고 **Grok 4.6 Fast [Cursor]** 를 고른다.

```bash
curl -sS http://127.0.0.1:18788/v1/models
```

목록이 비면 Cursor credential이 없거나 프로세스가 죽은 것이다.
`rubato auth` 후 로그는 `~/.rubato-pi/aside-cursor.out.log`다.

## 두 Grok

| 피커 | 경로 | 캐시 |
|---|---|---|
| Grok 4.6 Fast [Cursor] | Rubato Connect | Rubato 세션과 같음. T2부터 접두 히트 |
| Grok Subscription `grok-4.6` | xAI `api.x.ai` (기본 차로) | xAI 쪽. Cursor 접두 캐시가 아니다 |

Codex 앱만 OpenCodex를 쓴다. Aside Cursor를 10100에 다시 꽂지 않는다.

## 넣지 않은 것

- OpenCodex에 Fast id만 추가 — 캐시가 깨진다.
- `supportsFastMode`만 models.json에 남기기 — Aside가 런타임에서 버린다.
- 요청마다 새 프로세스 — T2가 다시 0%다. 죽음 복구는 launchd, 대화 캐시는 프로세스 메모리.
- Cursor 네이티브 도구 전부 번역 — 계약은 텍스트 + 접두 캐시다.
- 공식 외부 API — 로컬에서 Connect를 연다.

```bash
RUBATO_ASIDE_CURSOR_FIXTURE=/path/to/fixtures-v2 \
  node harness/rubato-pi/scripts/aside-cursor-cache-probe.mjs
```
