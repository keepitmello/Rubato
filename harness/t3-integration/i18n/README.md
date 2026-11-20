# 한국어 화면

설정 → 일반(General) → Display 묶음의 Language 에서 한국어를 고르면 화면이 한국어로 바뀐다. 언어 줄과 macOS 메뉴 번역은 T3 것이다.
T3 는 자기 i18n(gt-react, `apps/web/src/i18n/`)과 한국어 카탈로그 `ko.json` 을 갖고 있고, Rubato 는 그 위에 두 가지만 얹는다.

```
T3 문구    ko.json ──┐
                     ├─ 영어 원문이 같으면 Rubato 표현으로 바꿔 끼움 → 화면
Rubato 사전 ─────────┘   (en.json 이 해시 → 영어 원문을 알려 준다)
Rubato 문구 영어 그대로 렌더 → 한국어일 때 사전에서 찾아 페이지 글자를 바꿈 → 화면
```

| 자리 | 맡는 것 |
|---|---|
| `../overlay/apps/web/src/rubatoI18n.ko.json` | 한국어 사전. 영어(화면에 보이는 그대로) → 한국어 |
| `../overlay/apps/web/src/i18n/rubatoWording.ts` | T3 카탈로그를 불러올 때 같은 영어의 해시에 Rubato 표현을 넣는다 |
| `../overlay/apps/web/src/rubatoI18n.ts` | Rubato 문구를 페이지에서 바꿔 끼우는 장치. 사전 형식과 키 규칙의 정본 |
| `../i18n-edits.mjs` | 카탈로그 로더·언어 런타임·설정 검색·예전 설정 이전에 넣는 수정 |
| `glossary.md` | 사용자가 정한 용어와 말투 |
| `extract.mjs` | 적용된 T3 트리에서 T3 카탈로그 밖의 화면 문구를 사전 키로 뽑는다 |
| `translate.mjs` | 사전에 없는 키만 모델로 번역해 사전에 넣는다 (`prompt.md`) |

키는 해시가 아니라 영어라서 T3 를 올려도 사전을 다시 맞출 일이 없다. 영어가 그대로인 문구는 계속 Rubato 표현으로,
영어가 바뀐 문구는 T3 의 새 한국어로 보인다. 복수형은 한국어에 형태가 하나라 `other` 가지로 맞추고,
`select`(GitHub·GitLab 용어 고르기)가 든 문장은 T3 한국어를 쓴다.

예전 Rubato 설정 `uiLanguage: "ko"` 만 있는 사용자는 데스크톱이 설정 파일을 읽을 때 `language: "ko"` 로 연다
(`../overlay/apps/desktop/src/settings/rubatoUiLanguage.ts`). 다음 저장에서 옛 키는 빠진다.

## T3 를 올린 뒤

T3 카탈로그에 든 새 문구는 T3 한국어로 바로 보인다. Rubato 문구와 T3 가 번역하지 않는 문구만 사전 몫이다.

```sh
node extract.mjs --t3 ~/.rubato/t3-source > .work/strings.json
node translate.mjs --strings .work/strings.json
```

`translate.mjs` 는 값 자리(`{0}`)나 요소 자리(`<0/>`)를 깨거나 용어집을 어긴 답을
이유와 함께 한 번 더 보내고, 그래도 안 되면 `.work/rejected.json` 에 남긴다.
뜻이 갈려 모델이 메모를 단 것은 `.work/notes.json` 에 있다.

## 코드에서 못 뽑는 문구 찾기

코드가 조립하는 문구는 추출이 놓친다. 앱에서 localStorage `rubato:i18n-collect` 를 `"1"` 로 두고
다시 켜면, 사전에 없는 영어가 `window.__rubatoI18nMissing` 에 모인다. 화면을 돌고 나서 그 목록을
`strings.json` 형식(`{key, places}`)으로 만들어 `translate.mjs` 에 넘긴다.
