# Rubato for iPhone — TestFlight

App Store Connect: app "Rubato" (Apple ID 6834353824, SKU rubato-ios, bundle com.keepitmello.rubato,
team 5WGZKZGPQS). Internal group "Rubato Team" gets every processed build automatically.
Builds come from `build-ios.sh --testflight`.

## Test information (external testing)

- Privacy policy URL: https://rubato-app.pages.dev/privacy-policy (source: `site/index.html`, Cloudflare Pages
  project `rubato-app`; republish with `wrangler pages deploy site --project-name rubato-app --branch main`)
- Feedback email: keepitmello@naver.com
- Marketing URL: https://github.com/keepitmello/Rubato

### Beta app description

Rubato는 내 Mac에서 돌아가는 AI 동반자(컴패니언)와 코딩 스레드를 폰으로 가져옵니다. 컴패니언과
메시지로 이야기하고 전화를 걸 수 있고, 컴패니언이 먼저 전화를 걸어오기도 합니다. 통화가 끝나면
대화방에 통화 카드가 남아 눌러서 내용을 다시 볼 수 있습니다. 코딩 스레드에서는 Mac의 에이전트가
하는 일을 보고 이어서 지시할 수 있습니다. 폰은 같은 네트워크나 Tailscale로 내 Mac에 직접
연결되며, 쓰려면 Mac에 Rubato(https://github.com/keepitmello/Rubato)가 설치돼 있어야 합니다.

### What to test

컴패니언 목록과 대화방, 통화 걸기·받기(잠금 화면 포함), 통화 카드, 코딩 스레드 목록과 모델 로고,
Mac 짝짓기(QR)와 알림.

### Beta App Review notes

Rubato is a remote client for the Rubato app that the user runs on their own Mac (open source:
https://github.com/keepitmello/Rubato). The phone pairs with that Mac by scanning a QR code shown
in the Mac app (Settings → Connections) and then talks to it directly over the local network or
the user's Tailscale network; there is no account and no server-side login. VoIP push is used only
to ring the phone when the user's companion on their Mac places a call, and every VoIP push is
reported to CallKit. Without a paired Mac the app shows its empty state.
Demo access: a reviewer Mac pairing can be arranged on request at keepitmello@naver.com.
