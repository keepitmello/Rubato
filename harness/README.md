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

공식 GUI는 T3 Code다. `./install.sh --apply --gui` 또는 적용 때 묻는 선택으로
설치하고, 화면 제공자 이름은 Rubato다. 터미널 실행기는 **Rubato CLI** (`rubato`)다.

설치가 끝나면 새 셸을 열거나 안내된 rc 파일을 다시 읽는다.

```bash
rubato auth
rubato
```

credential은 저장소에 복사하지 않는다. `rubato auth`가 연결 상태를 보여 주고,
TTY에서는 프로바이더를 골라 OAuth·API 키·Anthropic 장기 setup-token을 추가한다.

## 실행

```bash
rubato       # Rubato CLI
rubato-pi    # Rubato CLI와 같은 실행기 (내부 이름)
rubato-gui   # 공식 GUI (T3)
rubato-soul  # 역할별 프롬프트 없이 SOUL.md만 사용
rubato dispatch <name> [grok|grokfast|fast|sol|fable] < brief.md
             # 비대화 워커. 브리프는 stdin, 끝나면 최종 답만 stdout.
             # PATH의 `dispatch`도 같은 명령이다.
rubato aside-cursor --install  # Aside Cursor 면. 설명은 aside-cursor.md
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

## 다시 시작

```bash
rubato restart        # 도는 것을 새 코드로 올린다
```

프로필 엔진·remote hub·데스크톱 앱을 그 순서로 내리고 올린다. 앱은 quit 요청으로만 내리고
(내장 T3 서버가 SQLite를 들고 있다), 내려가 있는 동안 핀과 overlay로 서버 번들을 다시
만든다 — 그 창이 유일한 자리다. 이미 핀에 맞으면 빌드 없이 지나간다. 앱이 꺼져 있으면
번들만 맞추고 켜지는 않는다. 없는 것은 조용히 건너뛰므로 GUI가 없는 머신에서도 그대로 쓴다.

**손으로 칠 일은 `rubato update` 와 `rubato restart` 뿐이다.** 원격에서 받아 반영하는 쪽이
`update`, 받지 않고 도는 것만 새 코드로 올리는 쪽이 `restart`다. 앱을 끄고·다시 만들고·켜는
일은 `t3-integration/restart-gui.sh` 하나가 쥐고 있고 두 동사가 같이 부르므로, 어느 쪽을
쳐도 앱까지 간다. 설치 스크립트를 직접 찾아 칠 일은 없다.

## 다시 빌드

```bash
rubato build
```

프롬프트 조각이나 엔진 소스를 직접 수정한 경우에만 사용한다. 일반 설치와 업데이트는 필요한
빌드를 자동으로 수행한다.

## 문제 해결

1. `rubato auth`로 연결 상태를 확인하고 필요한 계정을 추가한다.
2. `msearch --doctor`로 기억 검색 상태를 확인한다.
3. `rubato build`로 엔진과 프롬프트를 다시 만든다.
4. 그래도 실패하면 현재 commit, 실행한 명령, 첫 오류 메시지를 함께 이슈에 남긴다.

저장소: <https://github.com/keepitmello/Rubato>
