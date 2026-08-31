import { useMutation, useQuery } from "@tanstack/react-query"
import { Block, BlockFooter, Button, Card, Checkbox, List, ListInput, ListItem, Toolbar, ToolbarPane } from "konsta/react"
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
  const favoritePath = project?.path ?? customPath.trim()

  return <Shell title={title} onBack={goBack}>
    <main className="page-body">
      {step === "host" ? <>
        <div className="flow-intro"><h1>어느 Mac에서 시작할까요?</h1><p>세션은 선택한 Mac에서 계속 실행됩니다.</p></div>
        {hosts.length > 0 ? <List strongIos insetIos role="radiogroup" aria-label="연결된 Mac">{hosts.map((item) => <ListItem key={item.hostId} menuListItem menuListItemActive={host?.hostId === item.hostId} link chevron={false} linkComponent="button" linkProps={{ type: "button", role: "radio", "aria-checked": host?.hostId === item.hostId, "aria-label": item.displayName }} title={item.displayName} footer={item.ownerLogin} onClick={() => setHost(item)} />)}</List> : <Card><strong>연결된 Mac이 없어요.</strong><BlockFooter>설정에서 Mac을 먼저 연결하세요.</BlockFooter><Button outline onClick={() => navigate("/settings")}>설정 열기</Button></Card>}
      </> : null}

      {step === "project" ? <>
        <div className="flow-intro"><h1>무엇을 이어갈까요?</h1><p>최근 폴더나 즐겨찾기를 고르거나 경로를 직접 확인하세요.</p></div>
        {projects.isLoading ? <Block className="loading-block" aria-label="폴더를 불러오는 중" /> : projects.isError ? <Card className="permission" role="alert"><strong>폴더를 읽을 권한이 없어요.</strong><BlockFooter>Mac에서 Rubato의 폴더 접근을 허용한 뒤 다시 시도하세요.</BlockFooter><button className="text-button" onClick={() => void projects.refetch()}>다시 시도</button></Card> : <List strongIos insetIos role="radiogroup" aria-label="작업 폴더">{projects.data?.map((item) => <ListItem key={item.path} menuListItem menuListItemActive={project?.path === item.path} link chevron={false} linkComponent="button" linkProps={{ type: "button", role: "radio", "aria-checked": project?.path === item.path, "aria-label": item.label }} title={item.label} footer={`${item.path.replace(/^\/Users\/[^/]+/, "~")} · ${item.source === "favorite" ? "즐겨찾기" : "최근 사용"}`} onClick={() => { setProject(item); setCustomPath("") }} />)}</List>}
        <List strongIos insetIos><ListInput label="다른 폴더 경로" value={customPath} onChange={(event) => { setCustomPath((event.target as HTMLInputElement).value); setProject(undefined) }} autoCapitalize="none" autoCorrect="off" placeholder="~/Projects/my-project" /></List>
      </> : null}

      {step === "options" ? <>
        <div className="flow-intro"><h1>시작할 준비가 됐어요.</h1><p>선택한 폴더와 기본 설정을 확인하세요.</p></div>
        <List strongIos insetIos>
          <ListItem title={project?.label ?? customPath.split("/").filter(Boolean).at(-1)} footer={project?.path ?? customPath} />
          <ListItem title="모델" after={<select className="input compact-select" value={model} onChange={(event) => setModel(event.target.value)} aria-label="모델"><option value="default">Mac 기본값</option><option value="gpt-5.6">GPT-5.6</option><option value="claude">Claude</option></select>} />
          <ListItem title="추론 강도" after={<select className="input compact-select" value={thinking} onChange={(event) => setThinking(event.target.value)} aria-label="추론 강도"><option value="low">낮음</option><option value="medium">보통</option><option value="high">높음</option></select>} />
          <ListItem label title="이 폴더를 즐겨찾기에 추가" media={<Checkbox checked={favorites.includes(favoritePath)} onChange={() => toggleFavorite(favoritePath)} />} />
        </List>
      </> : null}
      {creation.isError ? <Card className="error-box" role="alert"><strong>세션을 시작하지 못했어요.</strong><p>{creation.error.message}</p></Card> : null}
    </main>
    <Toolbar className="toolbar-dock"><ToolbarPane className="toolbar-pane-fill"><Button className="toolbar-action" large rounded disabled={!canContinue || creation.isPending} onClick={primary}>{creation.isPending ? "시작하는 중…" : step === "options" ? "세션 시작" : "계속"}</Button></ToolbarPane></Toolbar>
  </Shell>
}
