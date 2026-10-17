# 한국어 화면

설정 → 모양 → Interface 의 언어를 한국어로 고르면 메뉴·버튼·설정 글자가 한국어로 바뀐다.
T3 컴포넌트는 고치지 않는다. React 가 화면에 쓴 영어 글자를 사전에서 찾아 그리기 직전에 바꿔 끼운다.

| 자리 | 맡는 것 |
|---|---|
| `../overlay/apps/web/src/rubatoI18n.ts` | 바꿔 끼우는 장치. 사전 형식과 키 규칙의 정본 |
| `../overlay/apps/web/src/rubatoI18n.ko.json` | 한국어 사전. 영어 키 → 한국어 |
| `../i18n-edits.mjs` | 설정 값, 언어 고르는 줄, 앱 시작, 설정 검색에 넣는 수정 |
| `glossary.md` | 사용자가 정한 용어와 말투 |
| `extract.mjs` | 적용된 T3 트리에서 화면 문구를 사전 키로 뽑는다 |
| `translate.mjs` | 사전에 없는 키만 모델로 번역해 사전에 넣는다 (`prompt.md`) |

## T3 를 올린 뒤

새 문구는 사전에 들기 전까지 영어로 보인다. 깨지지는 않는다.

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
