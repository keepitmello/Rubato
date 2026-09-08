# Backlog — 의도적으로 보류한 확장

이 파일은 SKILL.md에서 참조하지 않는다 — 점검표 세션에 로드되지 않게 하기 위해서다. 아래 항목들은 2026-08-03 GPT-5.6 Pro 검증(원 조사 세션 팔로업)에서 제안됐지만, **실사용이 생기기 전에 넣으면 채울 수 없는 칸이 허구를 부르고 규칙 충돌 표면만 커져서** 보류했다. 각 항목의 "추가 조건"이 오면 그때 이 파일에서 꺼내 설계한다. 상세 근거·원문: 로컬에 있다면 `~/.claude/roo-channel/.consult/product-framing-skill-review/response.md`.

## 1. Mode overlay — 위험 운용 단계(tier)와 사업 형태는 다른 축

추가 조건: 해커톤이 아닌 프로젝트(유료·사내·외주) 점검표를 처음 돌릴 때.

```yaml
tier: PROBE | STANDARD | COMMITMENT   # 위험·되돌릴 수 없음 (기존)
mode: HACKATHON | COMMERCIAL | INTERNAL | CLIENT_PROJECT   # 사업 형태 (신규 축)
```

| mode | 추가 필수 |
|---|---|
| HACKATHON | 공개 rubric, sponsor chain, demo proof, impact 규모 — 현재 스킬이 사실상 커버 |
| COMMERCIAL | payer, WTP, channel, sales motion, switching cost, economics |
| INTERNAL | 운영 owner, 도입 결정권자, workflow 삽입, 지원 부담 |
| CLIENT_PROJECT | 발주자/사용자/승인자 분리, acceptance, rollout, 변경 경계 |

## 2. COMMERCIAL overlay — 유료 프로젝트용

추가 조건: 실제 payer가 있는 프로젝트 점검표. 핵심 블록:

```markdown
Commercial demand:
- 실제 payer / budget owner:
- 현재 이 문제에 쓰는 돈·인건비·손실:
- 가격·계약 형태 가설:
- 가장 강한 WTP 근거 (말고 payer의 비용 있는 행동):
- 지불하지 않겠다고 판단할 조건:
```

주의: "얼마면 사겠느냐"는 hypothetical bias로 실제 지불과 체계적으로 어긋난다 — paid pilot·선결제·조달 개시 같은 행동이 신호다.

## 3. 실전(COMMITMENT) 사업성 계약 (현 §9 부록의 강화판)

추가 조건: 실제 실전급 프로젝트. 현 §9 부록은 책임 소재(owner·서명)는 잡지만 사업 성립은 검증 못 한다 — "VIABILITY owner: 대표 / 증거: 수요 있을 것으로 판단"은 self-approval이다. 강화 블록 6종: A 경제 구조(건당 반복 비용, 인간 검수 시간, 성립 경계) / B route to adoption(첫 고객 접근 경로, 조달·보안 단계, 최장 blocker) / C buying system(user·influencer·decider·buyer·gatekeeper별 outcome·거부권·증거) / D 운영 모델(온보딩·오류 대응·확장 시 먼저 무너지는 곳) / E 전략·법무 / F viability 가정의 실험 계약. 역할 겸임은 명시, 미확인 역할은 UNKNOWN으로 두고 HOLD.

## 4. Positioning Snapshot + market category

추가 조건: 심사·영업 대상이 세그먼트 선택을 요구할 때. 점검표 §1~4에서 파생:

```markdown
Best-fit customer(이 가치를 특히 세게 느끼는 조건 + 명시적 non-fit):
Market category(무엇의 한 종류로 이해시킬 것인가, 오해 시 생기는 문제):
```

현재 pitch-brief의 category anchor가 "gate에 직접 원천 없음"인 이유가 이 보류다.

## 5. Claim별 증거 원장

추가 조건: 한 점검표에 증거가 10개 이상 쌓여 "E2 있음" 수준 표기로는 어떤 주장을 지지하는지 헷갈릴 때.

```markdown
claim_id / claim / actor_role / evidence_grade / source / observed_at / supports_or_contradicts / limitations
```

현재는 02의 규칙("등급은 주장 단위, actor 역할 구별")으로 충분하다고 판단.

## 6. 프로토콜 자체의 미검증 가설 (첫 실전에서 관찰)

- 반론 2회 예산 — 실증 근거 없는 UX budget. 실전에서 답답하거나 시끄러우면 조정
- 사용자 원안(HUMAN_SEED) 동결 → 후보 3종 분산이 실제로 앵커링을 줄이는지 — 블라인드 프레임 전달의 INVENTED 지표로 관찰
- 하이브리드 4-pass가 설문조사식보다 나은지 — 대화가 자연스러웠는지 사용자 체감으로
