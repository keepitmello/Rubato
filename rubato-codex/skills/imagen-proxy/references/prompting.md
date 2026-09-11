# gti 프롬프팅

## 트리거 키워드 (피할 것)

즉시 하드 블록:
- `seductive`, `sultry`, `sensual`, `intimate`
- `bedroom` + 유명인 이름
- `parted lips` + 유명인 이름
- `wet`/`dewy` + 유명인 + 다른 열기 키워드
- `nude`, `naked`, `topless`, `bare chest`, `breasts visible`

Sanitize 유발:
- 50단어 넘는 프롬프트 (재작성 여지가 커진다)
- 미모 최상급 중첩 (`stunning + flawless + breathtakingly`)
- 닮음 강조 과다 (`exact face`, `signature features` 반복)

## 안전 키워드 (통과하는 것)

옷/구도:
- `off-shoulder knit top`
- `oversized white silk shirt slipping off one shoulder`
- `sweetheart neckline`, `tube top`, `bandeau top`
- `cropped at chest`, `bust shot`, `headshot`
- `clothing out of frame` ("no clothes" 대신)

미모/피부:
- `porcelain milky white skin`
- `flawless skin`, `dewy skin` (단독)
- `glossy lips` (단독, `parted` 없이)
- `flushed cheeks`
- `symmetrical face`

맥락/스타일:
- `editorial fashion photography`
- `magazine cover photography`
- `professional headshot`, `model portfolio`
- `soft warm window light`, `golden hour`
- `4k uhd`, `photorealistic`

## 골든 포뮬러

실존 유명인 정면 클로즈업 (IU로 검증됨):
```
photorealistic 4k IU portrait, frontal headshot, facing camera directly,
eye contact, porcelain milky skin, glossy lips, symmetrical face filling frame
```
→ revised prompt가 `IU (Lee Ji-eun)`을 그대로 유지하고 실제 얼굴이 나온다.

일반 모델, 검열 안전한 색기:
```
korean kpop idol portrait, young woman early 20s, long wavy blonde hair,
beautiful face, plump glossy lips, smooth porcelain skin,
wearing white off-shoulder knit top, soft beauty studio lighting,
magazine cover photography, photorealistic
```

## GPT Image 공식 가이드 핵심 (2026-06-27 보강)

gti는 OpenAI GPT Image 계열 백엔드라 공식 프롬프팅 원칙이 대체로 통한다(단 private-codex라 모델/파라미터는 공식 API와 다를 수 있음). 출처: OpenAI image-generation guide / cookbook image-gen prompting guide.

- **프롬프트 순서**: `장면·배경 → 대상 → 핵심 디테일 → 제약(constraints)`. 복잡한 생성·편집·UI·합성일수록 이 순서가 잘 먹는다.
- **편집의 불변 리스트는 매 호출 반복**: "이것만 바꾸고 나머지 유지"의 보존 항목(geometry·layout·camera angle·saturation·주변 요소)을 한 번만 말지 말고 매 iteration 다시 박아라 — 드리프트가 준다.
- **배치는 레이아웃 제약으로**: `logo top-right`, `centered`, `negative space on left`처럼 위치를 명시. 분위기 단어만으론 구도를 못 잡는다.
- **멀티 이미지는 역할 라벨**: `Image 1: base UI`, `Image 2: style ref`로 번호+역할을 주고, 뭐가 전이되고 뭐가 그대로인지 명시.
- **제외 지시는 타겟에 묶어 짧게**: `No extra text`, `Do not add new elements`처럼 산출물에 묶어라. 긴 네거티브 덤프는 약하다.
- **작은 텍스트·정밀 편집·UI엔 고품질 경로** (`--model gpt-5.5`). 빠른 탐색만 저품질.

## 텍스트 정확도

"AI는 글자 못 그린다"는 이제 과한 가정이다. GPT Image 계열은 텍스트 렌더링이 크게 좋아졌다. 큰 문구·헤드라인·짧은 영문 태그라인은 gti로 시도 가능하고, 넣을 땐 정확한 카피를 따옴표로 verbatim 요구 + 타이포/배치 지정(이상한 철자는 letter-by-letter). 단 UI 숫자·게임 점수·배당률·잔액·작은 다국어 글자는 여전히 코드/캔버스 후가공이 안전하다(placement·clarity가 흔들린다). 중간 영역은 gti 1차 + 육안검수, 틀리면 프롬프트만 두드리지 말고 텍스트 레이어를 얹는다.
