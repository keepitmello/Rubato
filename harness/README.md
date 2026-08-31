# Rubato 사용 가이드

Rubato를 설치하고 매일 운영할 때 필요한 내용만 정리한다.

## 설치

요구 사항은 Node 24+와 bun 1.4+다.

```bash
git clone --branch rubato/base https://github.com/keepitmello/Rubato.git
cd Rubato
./install.sh          # 설치 계획 확인
./install.sh --apply  # 실제 설치
```

설치가 끝나면 새 셸을 열거나 안내된 rc 파일을 다시 읽는다.

```bash
rubato auth
rubato
```

credential은 저장소에 복사하지 않는다. 각 provider의 기존 로그인 상태를 확인하고,
연결되지 않은 provider만 별도로 인증한다.

## 실행

```bash
rubato       # 기본 세션
rubato-pi    # rubato와 같은 실행기
rubato-soul  # 역할별 프롬프트 없이 SOUL.md만 사용
```

Rubato는 작업을 리드, 독립 작업자, 검증자로 나누고 각 작업에 맞는 모델을 선택한다.
대화에는 다음 행동을 바꾸는 근거만 남기고, 오래 쓸 정보는 기억 저장소로 분리한다.

## 기억 검색

`msearch`는 프로젝트별 기억을 검색한다.

```bash
msearch "검색어"     # 현재 프로젝트
msearch -a "검색어"  # 모든 프로젝트
msearch --doctor     # 저장소와 검색 인덱스 상태 확인
```

검색 인덱스가 멈춰도 기억 파일은 그대로 남는다. `msearch --doctor`의 안내에 따라
인덱스를 다시 만들면 된다.

## 업데이트

```bash
rubato update --check # 업데이트 유무만 확인
rubato update         # 변경 내용 확인 후 적용
```

업데이트는 dirty worktree를 덮어쓰지 않는다. 로컬 변경이 있으면 먼저 커밋하거나 별도로
보관한 뒤 다시 실행한다. 의존성, 프롬프트, 확장, 엔진 중 바뀐 부분만 다시 설치하거나 빌드한다.

## 다시 빌드

```bash
rubato build
```

프롬프트 조각이나 엔진 소스를 직접 수정한 경우에만 사용한다. 일반 설치와 업데이트는 필요한
빌드를 자동으로 수행한다.

## 스킬을 추가할 때

Rubato는 설치된 스킬의 이름과 설명을 모든 세션에 안내한다. 새 스킬이 늘어나면 실제로
사용하지 않는 세션에서도 안내문이 길어지므로, 기존 스킬로 해결할 수 없는 동작인지 먼저
확인한다.

새 스킬은 다음 내용을 설명할 수 있을 때 추가한다.

- 문제와 관련된 기존 스킬을 사용했는데도 같은 문제가 반복되었다.
- 기존 스킬에 짧게 보완하는 것보다 별도 이름으로 구분하는 편이 사용 시점을 더 명확하게 한다.
- 같은 모델과 작업으로 비교했을 때 스킬을 추가한 뒤의 행동이 실제로 달라졌다.
- 다른 스킬과 사용 목적이 겹치거나 더 이상 사용되지 않을 때 합치거나 삭제할 기준이 있다.

키워드가 들어갔는지, 문서가 몇 줄인지 확인하는 것만으로는 동작을 검증할 수 없다. 실제
작업 상황에서 어떤 도구를 선택하고, 언제 작업을 멈추거나 계속하는지 비교한다.

카탈로그 크기는 다음 명령으로 확인한다.

```bash
python3 harness/scripts/skill-picker.py --check
```

이 명령은 실제 세션과 같은 방식으로 `~/.agents/skills`와
`~/.rubato-pi/agent/skills`를 읽은 뒤, 안내문에 들어가는 스킬 수와 바이트 수를
출력한다. 현재 Rubato에는 고정된 크기 제한이 없다. 출력값은 새 스킬을 추가하기 전과
후에 모든 세션의 안내문이 얼마나 달라지는지 비교하는 데 사용한다.

## 문제 해결

1. `rubato auth`로 provider 연결 상태를 확인한다.
2. `msearch --doctor`로 기억 검색 상태를 확인한다.
3. `rubato build`로 엔진과 프롬프트를 다시 만든다.
4. 그래도 실패하면 현재 commit, 실행한 명령, 첫 오류 메시지를 함께 이슈에 남긴다.

저장소: <https://github.com/keepitmello/Rubato>
