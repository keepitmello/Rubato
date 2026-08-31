import { liveSessionSummarySchema } from "@rubato/remote-protocol"
import canonicalSession from "../../../rubato-remote-protocol/test/fixtures/live-session-summary.v1.json"
import type { ConversationEntry, HostInventory, ProjectChoice, RegisteredHost, SessionSnapshot } from "./types"

export const fixtureHost: RegisteredHost = {
  hostId: canonicalSession.hostId,
  displayName: "Mac mini",
  baseUrl: "https://mac-mini.example.ts.net/rubato/",
  ownerLogin: "you@example.com",
  pairedAt: "2026-08-30T09:00:00.000Z",
  lastSeenAt: "2026-08-31T01:00:00.000Z",
  protocolMin: 1,
  protocolMax: 1,
}

export const fixtureSession = liveSessionSummarySchema.parse(canonicalSession)

export const fixtureEntries: readonly ConversationEntry[] = [
  { id: "m1", kind: "message", role: "user", text: "호텔 태블릿 체크인 화면의 접근성 문제를 확인해 줘.", at: "2026-08-31T00:59:20.000Z" },
  { id: "t1", kind: "thinking", text: "화면 구조와 현재 테스트를 함께 확인하고 있습니다." },
  { id: "tool1", kind: "tool", name: "파일 읽기", summary: "체크인 화면과 접근성 테스트 4개를 확인했어요.", status: "done", output: "src/check-in/CheckIn.tsx\ntest/check-in.accessibility.test.tsx" },
  { id: "m2", kind: "message", role: "assistant", text: "레이블이 없는 방 선택 버튼과 키보드 초점 순서 문제를 찾았습니다. 버튼에 객실명을 포함한 접근 가능한 이름을 추가하고, 확인 단계가 선택 직후 오도록 순서를 고쳤습니다.\n\n관련 테스트를 실행했고 모두 통과했습니다.", at: "2026-08-31T01:00:00.000Z" },
  { id: "tool2", kind: "tool", name: "테스트", summary: "접근성 테스트 4개 통과", status: "done", output: "4 passed · 0 failed · 1.8s" },
]

export const fixtureSnapshot: SessionSnapshot = {
  summary: fixtureSession,
  revision: 123,
  lastSeq: 1828,
  entries: fixtureEntries,
  commands: [
    { name: "skill:review", description: "현재 변경점을 검토합니다.", category: "skill", remoteMode: "direct" },
    { name: "compact", description: "대화 문맥을 정리합니다.", category: "builtin", remoteMode: "native-action" },
    { name: "login", description: "터미널에서 공급자 인증을 설정합니다.", category: "builtin", remoteMode: "terminal-only" },
  ],
  tree: [
    { id: "entry-2", label: "처음 요청", current: false },
    { id: "entry-7", label: "접근성 수정", current: true },
  ],
}

export const fixtureInventory: readonly HostInventory[] = [
  { host: fixtureHost, sessions: [fixtureSession], connection: "online" },
  {
    host: { ...fixtureHost, hostId: "018f0c7a-2f3b-7c4d-8e5f-2234567890ab", displayName: "MacBook", baseUrl: "https://macbook.example.ts.net/rubato/" },
    sessions: [],
    connection: "offline",
    problem: "마지막 연결 이후 이 Mac에 닿지 않아요.",
  },
]

export const fixtureProjects: readonly ProjectChoice[] = [
  { path: "/Users/example/Projects/hotel-tablet", label: "Hotel Tablet", source: "recent" },
  { path: "/Users/example/Projects/Rubato", label: "Rubato", source: "favorite" },
  { path: "/Users/example/Work/design-system", label: "Design System", source: "recent" },
]
