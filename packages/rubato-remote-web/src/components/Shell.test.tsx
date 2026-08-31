import { fireEvent, render, screen } from "@testing-library/react"
import { App as KonstaApp } from "konsta/react"
import { useState } from "react"
import { Sheet, Shell } from "./Shell"

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("../lib/router", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/router")>(), navigate }))

function SheetHost() {
  const [open, setOpen] = useState(true)
  return <KonstaApp theme="ios"><Shell title="도구" back="/"><button>본문</button>{open ? <Sheet title="세션 도구" onClose={() => setOpen(false)}><p>시트 내용</p></Sheet> : null}</Shell></KonstaApp>
}

describe("native shell", () => {
  test("uses a Konsta navbar with a 44pt back control", () => {
    render(<KonstaApp theme="ios"><Shell title="Rubato" back="/" action={<button aria-label="설정 열기">⚙︎</button>}>목록</Shell></KonstaApp>)
    expect(screen.getByText("Rubato")).toBeInTheDocument()
    expect(screen.getByLabelText("뒤로 가기")).toBeInTheDocument()
    expect(screen.getByLabelText("설정 열기")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("뒤로 가기"))
    expect(navigate).toHaveBeenCalledWith("/")
  })

  test("keeps sheet dialog labelling, escape, and close control", () => {
    render(<SheetHost />)
    expect(screen.getByRole("dialog", { name: "세션 도구" })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("세션 도구 닫기"))
    expect(screen.queryByRole("dialog", { name: "세션 도구" })).not.toBeInTheDocument()
  })
})
