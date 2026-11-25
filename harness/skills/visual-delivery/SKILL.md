---
name: visual-delivery
description: "Read right before you draw a table, diagram, chart or ```svg/```mermaid block in an answer, or color a rating cell (좋음/나쁨, 매우 큼/소폭 퇴보): data-tone colors, svg drawing rules that read in light and dark, captions and source links, and what the Mac app, the iPhone and Telegram each show."
---

# 그려서 건네는 법

언제 그림을 꺼내고 답을 어떤 모양으로 잡는지는 시스템 프롬프트의 「정보를 건네는 방식」이 정한다. 여기는 그릴 때의 손기술이다.

## 표와 색 칸

표는 열 3~5개로, 칸엔 숫자, 이름, 짧은 구절만 넣어. 평가 칸은 `<span data-tone="good">매우 큼</span>`처럼 good(좋음), warn(비슷·주의), bad(나쁨)로 칠해. 앱에선 색 글자로, 폰과 텔레그램에선 🟢🟡🔴 점으로 보여.

## 그림

생김새, 배치, 겹쳐 보기, 간단한 차트는 ```svg 블록에 직접 그려. 여는 줄에 title="…"을 달면 그림 아래 캡션이 돼.
- viewBox를 꼭 달고, 폭은 600~700 정도로 그려. 앱이 화면에 맞춰 줄여.
- 선과 글자는 currentColor로 써야 라이트와 다크에서 다 읽혀. 강조색은 #3b82f6, #f97316처럼 중간 밝기로 고르고, 면은 fill-opacity 0.1~0.2로 옅게 칠해.
- 글자는 12~14 크기, 범례는 색 점과 짧은 이름으로.
- 실물을 대강 그린 거면 캡션에 개략도라고 밝히고 실제 자료 링크를 같이 줘.
- `<style>`, `<script>`, `<image>`, `<a>`, `<foreignObject>`, 바깥 주소를 가리키는 href나 url()은 지워진다. 그라디언트처럼 문서 안 `#id`를 가리키는 건 된다.
- 하나의 `<svg>`가 아니면 그림 대신 코드로 보여.

상자와 화살표 흐름은 ```mermaid 블록으로 써. 앱이 그대로 그려 줘.

## 접기와 출처

긴 근거는 `<details><summary>자세히</summary>` … `</details>`로 접어. 출처는 `[사이트 이름](URL)` 링크로 끝에 모아. 앱이 사이트 아이콘을 달아 보여 줘.

## 화면마다 보이는 모습

| 쓰는 것 | 맥 앱 | 아이폰 | 텔레그램 |
|---|---|---|---|
| svg 블록 | 그 자리 그림, 캡션, 눌러 확대 | 그 자리 그림, 캡션 | 캡션 단 PNG 사진 |
| mermaid 블록 | 다이어그램 | 다이어그램 | 코드 글자 |
| data-tone 칸 | 색 글자 | 🟢🟡🔴 점 | 🟢🟡🔴 점 |
| 표 | 표 | 표 | 행마다 한 줄 |
| `<details>` | 접힘 | 펼쳐짐, 제목 굵게 | 펼쳐짐, 제목 "▸ …" |
| 링크 | 사이트 아이콘 달린 링크 | 링크 | 링크 |

컴패니언은 이 모든 걸 `reply`의 text에 그대로 쓰면 돼. 그림 파일을 따로 만들 필요 없어.
