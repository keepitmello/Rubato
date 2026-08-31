import { fireEvent, render, screen } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { Conversation } from "./Conversation"
import { fixtureEntries, fixtureHost, fixtureSession } from "../lib/fixtures"
import type { ConversationEntry } from "../lib/types"

type MessageEntry = Extract<ConversationEntry, { kind: "message" }>

const hidden: readonly ConversationEntry[] = [
  { id: "n1", kind: "notice", text: "세션이 재연결되었습니다." },
  { id: "img1", kind: "image", alt: "체크인 미리보기", url: "https://example.com/preview.png" },
]

function user(id: string, text: string, extra: Partial<MessageEntry> = {}): MessageEntry {
  return { id, kind: "message", role: "user", text, ...extra }
}

function assistant(id: string, text: string, extra: Partial<MessageEntry> = {}): MessageEntry {
  return { id, kind: "message", role: "assistant", text, ...extra }
}

function renderConversation(entries: readonly ConversationEntry[], props: { working?: boolean } = {}) {
  return render(<KonstaApp theme="ios"><Conversation entries={entries} host={fixtureHost} liveSessionId={fixtureSession.liveSessionId} {...props} /></KonstaApp>)
}

describe("Conversation", () => {
  test("keeps only user and assistant messages in the DOM and accessibility tree", () => {
    const { container } = renderConversation([...fixtureEntries, ...hidden])

    expect(screen.getByRole("article", { name: "내 메시지" })).toHaveTextContent("호텔 태블릿 체크인 화면의 접근성 문제를 확인해 줘.")
    expect(screen.getByRole("article", { name: "Rubato 응답" })).toHaveTextContent("레이블이 없는 방 선택 버튼")
    expect(screen.getAllByRole("article")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: "작업 과정" })).not.toBeInTheDocument()

    expect(screen.queryByText("생각 과정")).not.toBeInTheDocument()
    expect(screen.queryByText("화면 구조와 현재 테스트를 함께 확인하고 있습니다.")).not.toBeInTheDocument()
    expect(screen.queryByText("파일 읽기")).not.toBeInTheDocument()
    expect(screen.queryByText("접근성 테스트 4개 통과")).not.toBeInTheDocument()
    expect(screen.queryByText("4 passed · 0 failed · 1.8s")).not.toBeInTheDocument()
    expect(screen.queryByText("세션이 재연결되었습니다.")).not.toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "체크인 미리보기", hidden: true })).not.toBeInTheDocument()
    expect(screen.queryByRole("status", { hidden: true })).not.toBeInTheDocument()
    expect(container.querySelector(".k-messages")).not.toBeNull()
    expect(container.querySelectorAll(".k-message")).toHaveLength(2)
    expect(container.querySelector(".entry")).toBeNull()
    expect(container.querySelector(".message")).toBeNull()
    expect(container.querySelector(".tool-card")).toBeNull()
    expect(container.querySelector(".tool-output")).toBeNull()
    expect(container.querySelector(".thinking")).toBeNull()
    expect(container.querySelector(".notice")).toBeNull()
  })

  test("collapses finished progress and keeps the last assistant bubble", () => {
    renderConversation([
      user("u1", "빌드를 고쳐 줘", { requestRunId: "run-1" }),
      assistant("a1", "로그를 보고 있어요", { requestRunId: "run-1", phase: "progress" }),
      assistant("a2", "실패 지점을 찾았어요", { requestRunId: "run-1", phase: "progress" }),
      assistant("a3", "패치 넣었어요", { requestRunId: "run-1", phase: "final" }),
    ])

    expect(screen.getByRole("article", { name: "내 메시지" })).toHaveTextContent("빌드를 고쳐 줘")
    expect(screen.getAllByLabelText("Rubato 응답")).toHaveLength(1)
    expect(screen.getByLabelText("Rubato 응답")).toHaveTextContent("패치 넣었어요")
    expect(screen.queryByText("로그를 보고 있어요")).not.toBeInTheDocument()
    expect(screen.queryByText("실패 지점을 찾았어요")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "작업 과정" }))
    expect(screen.getByRole("dialog", { name: "작업 과정" })).toBeInTheDocument()
    expect(screen.getByText("로그를 보고 있어요")).toBeInTheDocument()
    expect(screen.getByText("실패 지점을 찾았어요")).toBeInTheDocument()
  })

  test("keeps every assistant bubble while the turn is live", () => {
    renderConversation([
      user("u1", "빌드를 고쳐 줘", { requestRunId: "run-1" }),
      assistant("a1", "로그를 보고 있어요", { requestRunId: "run-1", phase: "progress" }),
      assistant("a2", "아직 보는 중", { requestRunId: "run-1", phase: "progress", streaming: true }),
    ], { working: true })

    expect(screen.queryByRole("button", { name: "작업 과정" })).not.toBeInTheDocument()
    expect(screen.getByText("로그를 보고 있어요")).toBeInTheDocument()
    expect(screen.getByText("아직 보는 중")).toBeInTheDocument()
  })

  test("keeps committed assistant bubbles visible during a tool gap when working", () => {
    renderConversation([
      user("u1", "빌드를 고쳐 줘", { requestRunId: "run-1" }),
      assistant("a1", "로그를 보고 있어요", { requestRunId: "run-1" }),
      assistant("a2", "이제 고칠게요", { requestRunId: "run-1" }),
    ], { working: true })

    expect(screen.queryByRole("button", { name: "작업 과정" })).not.toBeInTheDocument()
    expect(screen.getByText("로그를 보고 있어요")).toBeInTheDocument()
    expect(screen.getByText("이제 고칠게요")).toBeInTheDocument()
  })

  test("does not invent a final bubble when the turn stops on progress", () => {
    renderConversation([
      user("u1", "빌드를 고쳐 줘", { requestRunId: "run-1" }),
      assistant("a1", "로그를 보고 있어요", { requestRunId: "run-1", phase: "progress" }),
      assistant("a2", "여기서 멈췄어요", { requestRunId: "run-1", phase: "progress" }),
    ])

    expect(screen.getByRole("article", { name: "내 메시지" })).toBeInTheDocument()
    expect(screen.queryAllByLabelText("Rubato 응답")).toHaveLength(0)
    expect(screen.queryByText("여기서 멈췄어요")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "작업 과정" }))
    expect(screen.getByText("로그를 보고 있어요")).toBeInTheDocument()
    expect(screen.getByText("여기서 멈췄어요")).toBeInTheDocument()
  })
})
