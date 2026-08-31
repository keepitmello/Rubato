import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { createSession, fixtureMode, listProjects } from "../lib/api"
import { fixtureHost } from "../lib/fixtures"
import { navigate } from "../lib/router"
import { useAppStore } from "../lib/store"
import type { ProjectChoice, RegisteredHost } from "../lib/types"
import { Shell } from "../components/Shell"

export function NewSessionScreen() {
  const storedHosts = useAppStore((state) => state.hosts)
  const favorites = useAppStore((state) => state.preferences.favorites)
  const toggleFavorite = useAppStore((state) => state.toggleFavorite)
  const hosts = storedHosts.length > 0 ? storedHosts : fixtureMode ? [fixtureHost] : []
  const [step, setStep] = useState<"host" | "project" | "options">("host")
  const [host, setHost] = useState<RegisteredHost | undefined>(hosts[0])
  const [project, setProject] = useState<ProjectChoice>()
  const [customPath, setCustomPath] = useState("")
  const [model, setModel] = useState("default")
  const [thinking, setThinking] = useState("high")
  const projects = useQuery({ queryKey: ["projects", host?.hostId], queryFn: () => listProjects(host!), enabled: Boolean(host) && step === "project" })
  const creation = useMutation({
    mutationFn: () => createSession(host!, { cwd: project?.path ?? customPath.trim(), ...(model !== "default" ? { model } : {}), thinkingLevel: thinking }),
    onSuccess: (session) => navigate(`/session/${host!.hostId}/${session.liveSessionId}`),
  })
  const title = step === "host" ? "Mac 선택" : step === "project" ? "작업 폴더" : "세션 설정"
  const goBack = () => step === "options" ? setStep("project") : step === "project" ? setStep("host") : navigate("/")
  const canContinue = step === "host" ? Boolean(host) : step === "project" ? Boolean(project || customPath.trim()) : true
  const primary = () => {
    if (step === "host") setStep("project")
    else if (step === "project") setStep("options")
    else creation.mutate()
  }

  return <Shell title={title} onBack={goBack}>
    <main className="content">
      <div className="eyebrow">{step === "host" ? "1 / 3" : step === "project" ? "2 / 3" : "3 / 3"}</div>
      <h1 className="hero-title">{step === "host" ? "어느 Mac에서 시작할까요?" : step === "project" ? "무엇을 이어갈까요?" : "시작할 준비가 됐어요."}</h1>
      <p className="hero-copy">{step === "host" ? "세션은 선택한 Mac에서 계속 실행됩니다." : step === "project" ? "최근 폴더나 즐겨찾기를 고르거나 경로를 직접 확인하세요." : "선택한 폴더와 기본 설정을 확인하세요."}</p>

      {step === "host" ? hosts.length > 0 ? <div className="surface" role="radiogroup" aria-label="연결된 Mac">{hosts.map((item) => <button key={item.hostId} role="radio" aria-checked={host?.hostId === item.hostId} className="choice" onClick={() => setHost(item)}><strong>{item.displayName}</strong><div className="meta">{item.ownerLogin}</div></button>)}</div> : <div className="surface empty"><div className="empty-mark">⌁</div><strong>연결된 Mac이 없어요.</strong><p className="meta">설정에서 Mac을 먼저 연결하세요.</p><button className="secondary" onClick={() => navigate("/settings")}>설정 열기</button></div> : null}

      {step === "project" ? <>
        {projects.isLoading ? <div className="skeleton" aria-label="폴더를 불러오는 중" /> : projects.isError ? <div className="surface permission" role="alert"><strong>폴더를 읽을 권한이 없어요.</strong><div className="meta">Mac에서 Rubato의 폴더 접근을 허용한 뒤 다시 시도하세요.</div><button className="text-button" onClick={() => void projects.refetch()}>다시 시도</button></div> : <div className="surface" role="radiogroup" aria-label="작업 폴더">{projects.data?.map((item) => <button key={item.path} className="choice" role="radio" aria-checked={project?.path === item.path} onClick={() => { setProject(item); setCustomPath("") }}><strong>{item.label}</strong><div className="meta path">{item.path.replace(/^\/Users\/[^/]+/, "~")} · {item.source === "favorite" ? "즐겨찾기" : "최근 사용"}</div></button>)}</div>}
        <label className="field"><span className="field-label">다른 폴더 경로</span><input className="input" value={customPath} onChange={(event) => { setCustomPath(event.target.value); setProject(undefined) }} autoCapitalize="none" autoCorrect="off" placeholder="~/Projects/my-project" /></label>
      </> : null}

      {step === "options" ? <div className="surface" style={{ padding: 16 }}>
        <div><strong>{project?.label ?? customPath.split("/").filter(Boolean).at(-1)}</strong><div className="meta path">{project?.path ?? customPath}</div></div>
        <label className="field"><span className="field-label">모델</span><select className="input" value={model} onChange={(event) => setModel(event.target.value)}><option value="default">Mac 기본값</option><option value="gpt-5.6">GPT-5.6</option><option value="claude">Claude</option></select></label>
        <label className="field"><span className="field-label">추론 강도</span><select className="input" value={thinking} onChange={(event) => setThinking(event.target.value)}><option value="low">낮음</option><option value="medium">보통</option><option value="high">높음</option></select></label>
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={favorites.includes(project?.path ?? customPath.trim())} onChange={() => toggleFavorite(project?.path ?? customPath.trim())} /> 이 폴더를 즐겨찾기에 추가</label>
      </div> : null}
      {creation.isError ? <div className="error-box" role="alert"><strong>세션을 시작하지 못했어요.</strong><p>{creation.error.message}</p></div> : null}
    </main>
    <div className="fixed-action"><button className="primary" disabled={!canContinue || creation.isPending} onClick={primary}>{creation.isPending ? "시작하는 중…" : step === "options" ? "세션 시작" : "계속"}</button></div>
  </Shell>
}
