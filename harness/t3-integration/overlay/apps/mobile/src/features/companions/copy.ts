// The words the companion screens show, in the phone's language: Korean when the phone is set to
// Korean, English otherwise. The rest of the app is T3's English; these screens are the person's
// rooms with Segno and Roo, so they speak the person's language.

const KO = {
  noCompanions: "컴패니언이 아직 없어",
  noCompanionsDetail: "Mac의 Rubato에서 컴패니언을 켜면 여기에 나타나.",
  notConnected: "Mac에 연결되지 않았어",
  notConnectedDetail: "Tailscale로 Mac에 연결되면 컴패니언이 보여.",
  roomLoading: "대화를 불러오는 중…",
  roomMissing: "아직 대화가 없어",
  roomMissingDetail: "Mac에서 이 컴패니언의 대화가 시작되면 열 수 있어.",
  placeholder: "메시지 보내기",
  send: "보내기",
  dictate: "받아쓰기",
  call: "전화 걸기",
  cannotCall: "지금은 전화할 수 없어",
  back: "뒤로",
  writing: "입력 중",
  // Call cards.
  missedCall: "부재중 전화",
  noAnswer: "받지 않음",
  declinedCall: "거절한 전화",
  calling: "전화 거는 중…",
  onCall: "통화 중…",
  voiceCall: "음성 통화",
  incoming: "받은 전화",
  outgoing: "건 전화",
  nothingSaid: "통화에서 오간 말이 없어.",
  // The call screen.
  connecting: "연결하는 중…",
  listening: "듣고 있어",
  thinking: "생각하는 중…",
  speaking: "말하는 중",
  mute: "음소거",
  speaker: "스피커",
  hangUp: "끊기",
  answer: "받기",
  decline: "거절",
  callFailed: "통화가 연결되지 않았어",
  dismiss: "닫기",
  answeredElsewhere: "다른 기기에서 받았어",
  isCalling: "전화가 왔어",
};

const EN: typeof KO = {
  noCompanions: "No companions yet",
  noCompanionsDetail: "Turn on a companion in Rubato on your Mac and it shows up here.",
  notConnected: "Not connected to your Mac",
  notConnectedDetail: "Connect to your Mac over Tailscale to see your companions.",
  roomLoading: "Loading the conversation…",
  roomMissing: "No conversation yet",
  roomMissingDetail: "It opens once this companion's conversation starts on your Mac.",
  placeholder: "Message",
  send: "Send",
  dictate: "Dictate",
  call: "Call",
  cannotCall: "Can't call right now",
  back: "Back",
  writing: "typing",
  missedCall: "Missed call",
  noAnswer: "No answer",
  declinedCall: "Declined call",
  calling: "Calling…",
  onCall: "On a call…",
  voiceCall: "Voice call",
  incoming: "Incoming",
  outgoing: "Outgoing",
  nothingSaid: "Nothing was said on this call.",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  mute: "Mute",
  speaker: "Speaker",
  hangUp: "End",
  answer: "Accept",
  decline: "Decline",
  callFailed: "The call did not connect",
  dismiss: "Dismiss",
  answeredElsewhere: "Answered on another device",
  isCalling: "is calling",
};

export type CopyKey = keyof typeof KO;

/** The phone's language as Intl reports it, e.g. "ko-KR". */
export const phoneLocale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en";
  }
};

export function copyFor(locale: string) {
  return locale.toLowerCase().startsWith("ko") ? KO : EN;
}

export const copy = copyFor(phoneLocale());
