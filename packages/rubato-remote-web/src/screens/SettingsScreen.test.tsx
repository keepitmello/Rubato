import { fireEvent, render, screen } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { SettingsScreen } from "./SettingsScreen"

describe("settings shell", () => {
  beforeEach(() => history.replaceState(null, "", "/settings"))

  test("uses native lists and a single primary pairing action", () => {
    render(<KonstaApp theme="ios"><SettingsScreen /></KonstaApp>)
    expect(screen.getByText("연결된 Mac")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Mac 연결" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Mac 연결" }))
    expect(screen.getByRole("dialog", { name: "Rubato Mac 연결" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "네, 카메라 열기" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "아니요, QR 여는 법 보기" }))
    fireEvent.click(screen.getByRole("button", { name: "QR 대신 터미널 아래의 주소·코드 입력" }))
    expect(screen.getByLabelText("Mac 주소")).toBeInTheDocument()
    expect(screen.getByLabelText("연결 코드")).toBeInTheDocument()
  })
})
