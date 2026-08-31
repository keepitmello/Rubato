import { render, screen } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { Conversation } from "./Conversation"
import { fixtureEntries, fixtureHost, fixtureSession } from "../lib/fixtures"
import type { ConversationEntry } from "../lib/types"

const hidden: readonly ConversationEntry[] = [
  { id: "n1", kind: "notice", text: "세션이 재연결되었습니다." },
  { id: "img1", kind: "image", alt: "체크인 미리보기", url: "https://example.com/preview.png" },
]

describe("Conversation", () => {
  test("keeps only user and assistant messages in the DOM and accessibility tree", () => {
    const { container } = render(<KonstaApp theme="ios"><Conversation entries={[...fixtureEntries, ...hidden]} host={fixtureHost} liveSessionId={fixtureSession.liveSessionId} /></KonstaApp>)

    expect(screen.getByRole("article", { name: "내 메시지" })).toHaveTextContent("호텔 태블릿 체크인 화면의 접근성 문제를 확인해 줘.")
    expect(screen.getByRole("article", { name: "Rubato 응답" })).toHaveTextContent("레이블이 없는 방 선택 버튼")
    expect(screen.getAllByRole("article")).toHaveLength(2)

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
})
