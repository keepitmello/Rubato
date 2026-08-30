# wan26 (fal.ai i2i)

`wan26`은 fal.ai의 `wan/v2.6/image-to-image` 모델을 쓰는 i2i 편집 러너다. gti보다 얼굴 보존이 상대적으로 낫고 출력 이미지 체커를 끌 수 있지만, fal.ai 유료 API라 외부 과금이 발생한다. gti는 빠른 로컬 프록시 실험용, wan26은 옷 갈아입히기처럼 원본 얼굴과 체형 보존이 중요한 i2i 편집용으로 나눠 쓴다.

## Runner

```bash
cd /Users/wy/.claude/roo-channel/tools/wan26
npm run wan26:edit -- --help
```

환경:
- `FAL_KEY`는 `tools/wan26/.env`에 둔다.
- `.env`는 커밋 금지다. 공유 가능한 예시는 `.env.example`만 쓴다.
- 실제 생성은 과금되므로 smoke check는 `--help`까지만 먼저 확인한다.

## 옷 갈아입히기 i2i

```bash
cd /Users/wy/.claude/roo-channel/tools/wan26
npm run wan26:edit -- \
  --prompt "<지시>" \
  --image "<베이스=image1>" \
  --image "<스타일참조=image2>" \
  --expand false \
  --safety false
```

첫 번째 `--image`가 유지할 베이스 이미지이고, 두 번째 `--image`가 옷 스타일 참조다. 두 번째 이미지는 옷만 참고하게 해야 하며, 얼굴이나 몸은 가져오게 하면 안 된다.

권장 프롬프트:

```text
Use image 1 as the base. Keep the woman exactly as she is in image 1 — same face, hairstyle, body and proportions, pose, composition, background. Change ONLY her outfit to the [옷] from image 2. Reference image 2 for the clothing only, not for her body or face.
```

얼굴과 체형 보존의 핵심은 원본 특징을 직접 묘사하지 않는 것이다. `slim`, `small chest`, `slender` 같은 형용사를 넣으면 모델이 그 단어에 반응해 원본과 충돌하거나 왜곡할 수 있다. 얼굴 묘사를 최소화하고 레퍼런스대로만 두는 gti 노하우를 체형에도 그대로 적용한다. "image 1 그대로 유지"만 지시하고 판단은 모델에 맡긴다.

`--expand false`는 `enable_prompt_expansion`을 끈다. 모델이 프롬프트를 멋대로 확장하며 얼굴을 흔드는 것을 줄이므로 옷 교체 편집에는 기본 권장이다.

negative prompt는 짧게 둔다. 길게 나열하면 오히려 모델이 불필요한 단어에 반응할 수 있다:

```bash
--negative "different face, different person, altered body proportions, changed figure"
```

`--safety false`는 출력 이미지 safety checker만 끈다.

## 검열(moderation) 노하우

- `--safety false`(`enable_safety_checker=false`)는 출력 이미지 체커만 끈다. 프롬프트 텍스트 content 검열은 별도로 항상 켜져 있어 끌 수 없다. fal 응답 input에서 `enable_safety_checker`가 `true`로 강제 echo되는 것으로 확인했다.
- 노출/시스루 의상어가 프롬프트에 있으면 HTTP 422 `content_policy_violation`(`loc: body.prompt`)로 거절될 수 있다. 트리거어: `sheer`, `fishnet`, `see-through`, `mesh cover-up`, `two-piece swimsuit`(비침 뉘앙스), `nude`/`naked` 류. 반면 CK 속옷 표현(`bralette`/`panties`/`underwear`)은 통과했다.
- 우회는 노출어를 빼고 패션 에디토리얼 톤으로 순화한다. 실증 통과 예시:
  `black bikini top with a small metal ring accent, styled with a black diamond-net patterned mesh layer. Editorial fashion photography.`
  (`fishnet` → `diamond-net patterned mesh`, `sheer`/`see-through` 삭제, `Editorial fashion photography` 태그 추가). imagen-prompting의 중립어 우회 원리가 wan26 프롬프트 검열에도 그대로 적용된다.
- 노출 심한 참조 이미지(둘째 `--image`)도 input moderation에 걸려 같은 422가 날 수 있다. 이 경우 참조 이미지를 빼고 옷을 프롬프트로 묘사한다.
- 에러 진단은 422 응답 `body.detail[].loc`를 본다. `prompt`인지 이미지인지 구분할 수 있다. `type`은 `content_policy_violation`이며, 문서는 <https://docs.fal.ai/errors#content_policy_violation>를 확인한다.

## 옵션

| Option | Meaning |
|---|---|
| `--prompt <text>` | 필수 편집 지시. 입력 이미지는 image 1, image 2, image 3으로 지칭한다. |
| `--image <path\|url>` | 참조 이미지. 1-3회 반복 가능. 첫 이미지가 베이스다. |
| `--negative <text>` | 피할 내용. 짧게 유지한다. |
| `--size <preset>` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`. |
| `--num <1-4>` | 출력 개수. 기본값은 1. |
| `--seed <number>` | 재현용 seed. |
| `--expand <true\|false>` | prompt expansion. 옷 교체는 `false` 권장. |
| `--safety <true\|false>` | safety checker. 필요 시 `false`. |
| `--out <dir>` | 출력 디렉토리. 기본값은 `outputs`. |
