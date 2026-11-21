// The words the companion screens show, in the app's language (Settings › Language, or the
// phone's when that follows the system): Korean for Korean, English otherwise. The language comes
// from the app's translation layer (companionLocale.ts), not from Intl: on iOS Intl reports the
// app bundle's language, which is English only, so a Korean phone read as English.

const KO = {
  noCompanions: "컴패니언이 아직 없어",
  noCompanionsDetail: "아래에서 새 컴패니언을 만들거나 Mac의 Rubato에서 켜면 여기에 나타나.",
  notConnected: "Mac에 연결되지 않았어",
  notConnectedDetail: "Tailscale로 Mac에 연결되면 컴패니언이 보여.",
  roomLoading: "대화를 불러오는 중…",
  roomMissing: "아직 대화가 없어",
  roomMissingDetail: "Mac에서 이 컴패니언의 대화가 시작되면 열 수 있어.",
  placeholder: "메시지 보내기",
  send: "보내기",
  remove: "빼기",
  dictate: "받아쓰기",
  call: "전화 걸기",
  cannotCall: "지금은 전화할 수 없어",
  back: "뒤로",
  writing: "입력 중",
  toLatest: "맨 아래로",
  edit: "수정",
  copyMessage: "복사",
  editing: "메시지 수정 중 · 보내면 여기서부터 다시 시작해",
  cancel: "취소",
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
  openTranscript: "통화 내용 보기",
  callGone: "이 통화를 찾을 수 없어.",
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
  companionsSettings: "컴패니언",
  names: "이름",
  nameLabel: "이름",
  namesFooter: "이 폰에서만 보이는 이름이야. 비우면 기본 이름으로 돌아가고, Mac과 데스크탑의 이름은 그대로야.",
  onTheMac: "Mac에서는",
  callThinking: "통화 중 생각",
  callThinkingFooter: "통화하는 동안만 바뀌고, 끊으면 평소 수준으로 돌아가. 덜 생각할수록 빨리 답해.",
  callEffortConversation: "대화와 같게",
  callEffortConversationDetail: "평소 대화 수준 그대로",
  callEffortLow: "낮게",
  callEffortLowDetail: "가장 빨리 답해",
  callEffortMedium: "보통",
  callEffortMediumDetail: "기본값",
  callEffortHigh: "높게",
  callEffortHighDetail: "따져 봐야 할 때 더 깊게 생각해",
  saveFailed: "저장하지 못했어",
  // A new companion and its first conversation.
  newCompanion: "새 컴패니언",
  creating: "만드는 중…",
  waking: "눈 뜨는 중…",
  createFailed: "새 컴패니언을 만들지 못했어",
  pickMac: "어느 Mac에 만들까?",
  onboardingName: "이름",
  onboardingCallsUser: "호칭",
  onboardingWork: "하는 일",
  onboardingRelationship: "우리 사이",
  onboardingLook: "모습",
  onboardingSpeech: "말투",
  onboardingCloseness: "거리감",
  onboardingLater: "나중에",
  onboardingSet: "정해짐",
  // A change the companion proposes to itself.
  apply: "적용",
  more: "더 고쳐줘",
  keepAsIs: "그대로 둘래",
  applied: "적용했어",
  declined: "그대로 뒀어",
  applyFailed: "적용하지 못했어",
  stale: "그 사이 글이 바뀌었어",
  staleDetail: "지금 글을 보고 다시 고쳐 달라고 할 수 있어.",
  askAgain: "다시 고쳐 달라기",
  askAgainText: "지금 글 기준으로 다시 고쳐줘",
  morePlaceholder: "어떻게 더 고칠지 말해줘",
  pictureApply: "이 사진으로",
  // The profile and its picture.
  profile: "프로필",
  changePicture: "사진 바꾸기",
  takePhoto: "사진 찍기",
  chooseFromAlbum: "앨범에서 고르기",
  chooseFromRoom: "대화에 온 사진에서 고르기",
  askToDraw: "{name}한테 그려 달라기",
  drawRequest: "내 프사로 쓸 네 그림 하나 그려줘. ",
  viewPicture: "지금 사진 크게 보기",
  roomPictures: "대화에 온 사진",
  noRoomPictures: "아직 대화에 온 사진이 없어",
  cropTitle: "동그라미 안에 맞춰 줘",
  choose: "선택",
  pictureFailed: "사진을 바꾸지 못했어",
  cameraUnavailable: "카메라를 쓸 수 없어",
  cameraUnavailableDetail: "설정 › Rubato에서 카메라를 켜 줘.",
  savingPicture: "바꾸는 중…",
};

const EN: typeof KO = {
  noCompanions: "No companions yet",
  noCompanionsDetail: "Make a new companion below, or turn one on in Rubato on your Mac.",
  notConnected: "Not connected to your Mac",
  notConnectedDetail: "Connect to your Mac over Tailscale to see your companions.",
  roomLoading: "Loading the conversation…",
  roomMissing: "No conversation yet",
  roomMissingDetail: "It opens once this companion's conversation starts on your Mac.",
  placeholder: "Message",
  send: "Send",
  remove: "Remove",
  dictate: "Dictate",
  call: "Call",
  cannotCall: "Can't call right now",
  back: "Back",
  writing: "typing",
  toLatest: "Scroll to latest",
  edit: "Edit",
  copyMessage: "Copy",
  editing: "Editing — sending goes back to this message",
  cancel: "Cancel",
  missedCall: "Missed call",
  noAnswer: "No answer",
  declinedCall: "Declined call",
  calling: "Calling…",
  onCall: "On a call…",
  voiceCall: "Voice call",
  incoming: "Incoming",
  outgoing: "Outgoing",
  nothingSaid: "Nothing was said on this call.",
  openTranscript: "Opens the call transcript",
  callGone: "This call could not be found.",
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
  companionsSettings: "Companions",
  names: "Names",
  nameLabel: "name",
  namesFooter: "Names shown on this phone only. Clear one to go back to the default; the Mac and the desktop keep theirs.",
  onTheMac: "On the Mac:",
  callThinking: "Thinking on calls",
  callThinkingFooter: "Only while you are on a call; the usual level comes back when it ends. Less thinking answers sooner.",
  callEffortConversation: "Same as chat",
  callEffortConversationDetail: "The usual level of its conversation",
  callEffortLow: "Low",
  callEffortLowDetail: "Answers fastest",
  callEffortMedium: "Medium",
  callEffortMediumDetail: "Default",
  callEffortHigh: "High",
  callEffortHighDetail: "Thinks harder when something needs working out",
  saveFailed: "Could not save",
  newCompanion: "New companion",
  creating: "Making it…",
  waking: "Waking up…",
  createFailed: "Could not make a new companion",
  pickMac: "Which Mac should it live on?",
  onboardingName: "Name",
  onboardingCallsUser: "What it calls you",
  onboardingWork: "Your work",
  onboardingRelationship: "Relationship",
  onboardingLook: "Look",
  onboardingSpeech: "Speech",
  onboardingCloseness: "Closeness",
  onboardingLater: "later",
  onboardingSet: "set",
  apply: "Apply",
  more: "Change more",
  keepAsIs: "Keep as is",
  applied: "Applied",
  declined: "Kept as it was",
  applyFailed: "Could not apply",
  stale: "The text changed in the meantime",
  staleDetail: "You can ask for the change again on the current text.",
  askAgain: "Ask again",
  askAgainText: "Please redo that change on the current text",
  morePlaceholder: "Say what else to change",
  pictureApply: "Use this picture",
  profile: "Profile",
  changePicture: "Change picture",
  takePhoto: "Take a photo",
  chooseFromAlbum: "Choose from album",
  chooseFromRoom: "Choose from the conversation",
  askToDraw: "Ask {name} to draw one",
  drawRequest: "Draw a picture of yourself for your profile. ",
  viewPicture: "View current picture",
  roomPictures: "Pictures in the conversation",
  noRoomPictures: "No pictures in the conversation yet",
  cropTitle: "Fit it in the circle",
  choose: "Choose",
  pictureFailed: "Could not change the picture",
  cameraUnavailable: "The camera is unavailable",
  cameraUnavailableDetail: "Turn on the camera for Rubato in Settings.",
  savingPicture: "Saving…",
};

export type CopyKey = keyof typeof KO;

/** Where the app's language comes from (companionLocale.ts); unset in tests and before it loads. */
let localeSource: (() => string | null) | null = null;
let appLocale: string | null = null;

export function setCopyLocaleSource(source: () => string | null) {
  localeSource = source;
  appLocale = null;
}

/** The app switched language: the next words and dates use it. */
export function setCopyLocale(locale: string) {
  appLocale = locale;
}

const intlLocale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en";
  }
};

/** The app's language, e.g. "ko"; read once from its source, then kept until it switches. */
export const phoneLocale = (): string => {
  if (appLocale === null && localeSource !== null) {
    try {
      appLocale = localeSource();
    } catch {
      appLocale = null;
    }
  }
  return appLocale ?? intlLocale();
};

export function copyFor(locale: string) {
  return locale.toLowerCase().startsWith("ko") ? KO : EN;
}

/** The words in the app's language at the moment they are read. */
export const copy: typeof KO = new Proxy({} as typeof KO, {
  get: (_target, key) => copyFor(phoneLocale())[key as CopyKey],
});

const formats = new Map<string, Intl.DateTimeFormat>();
/** A date format in the app's language, made once per language and options. */
export function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = phoneLocale();
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

/** Whether a Korean word ends in a final consonant (받침), which picks 이라고 over 라고. */
export function hasFinalConsonant(word: string): boolean {
  const code = word.trim().codePointAt(word.trim().length - 1) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

/** "나를 오빠라고 불러" / "Calls you 오빠": what the companion calls the person, as its profile says it. */
export function callsUserLine(value: string, locale = phoneLocale()): string {
  if (!locale.toLowerCase().startsWith("ko")) return `Calls you ${value}`;
  return `나를 ${value}${hasFinalConsonant(value) ? "이라고" : "라고"} 불러`;
}

/** "10월 20일부터 함께" / "Together since Oct 20". */
export function sinceLine(iso: string, locale = phoneLocale()): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const date = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(at);
  return locale.toLowerCase().startsWith("ko") ? `${date}부터 함께` : `Together since ${date}`;
}

/** A copy line with `{name}` filled in. */
export const withName = (line: string, name: string) => line.replaceAll("{name}", name);
