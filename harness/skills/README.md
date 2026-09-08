# skills — 배포용 사본 (생성물)

정본이 아니다. 정본은 `~/.agents/skills` 이고 이 디렉토리는
`harness/scripts/bundle-skills.sh` 가 뜬 사본이다.

**여기서 고치지 마라.** 정본에서 고치고 스크립트를 다시 돌린다.
이 쪽만 고치면 다음 실행이 조용히 되돌린다.

새 기기는 이 레포를 clone 한 뒤 설치기가 이것을 `~/.agents/skills` 로 풀어 준다.
Rubato와 기존 shared CLI는 이 설치본을 사용한다.
Codex는 별도 `rubato-codex` 플러그인으로 설치하며, 그 설치기가 공유 중복을 비활성화한다.
taskforce·dispatching·model-guide의 Codex 전용본은 `rubato-codex/skills`가 정본이다.

담긴 스킬 25개. 심링크는 실체를 따라가 떴다.
