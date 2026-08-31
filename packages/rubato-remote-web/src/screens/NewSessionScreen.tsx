import { useMutation, useQuery } from "@tanstack/react-query"
import { Button, Checkbox, Toolbar, ToolbarPane } from "konsta/react"
import { useState } from "react"
import { AppIcon } from "../components/Icon"
import { EmptyState, LoadingCards, Shell } from "../components/Shell"
import { createSession, fixtureMode, listProjects } from "../lib/api"
import { fixtureHost } from "../lib/fixtures"
import { navigate } from "../lib/router"
import { useAppStore } from "../lib/store"
import type { ProjectChoice, RegisteredHost } from "../lib/types"

type Step = "host" | "project" | "options"
const steps: readonly Step[] = ["host", "project", "options"]

function stepIndex(step: Step): number {
  return steps.indexOf(step)
}

function StepProgress({ step }: { step: Step }) {
  const current = stepIndex(step)
  return <ol className="flow-progress" aria-label="새 세션 진행 단계">
    {[
      ["Mac", "mac"],
      ["폴더", "folder"],
      ["확인", "check"],
    ].map(([label, icon], index) => <li key={label} className={index <= current ? "flow-step-active" : ""} aria-current={index === current ? "step" : undefined}>
      <span className="flow-step-dot" aria-hidden="true"><AppIcon name={icon as "mac" | "folder" | "check"} size={16} /></span>
      <span>{label}</span>
    </li>)}
  </ol>
}

function ChoiceButton({
  selected,
  title,
  detail,
  icon,
  label,
  onClick,
  trailing,
}: {
  selected: boolean
  title: string
  detail: string
  icon: "mac" | "folder"
  label: string
  onClick: () => void
  trailing?: string
}) {
  return <button
    type="button"
    className={`selection-card ${selected ? "selection-card-selected" : ""}`}
    role="radio"
    aria-checked={selected}
    aria-label={label}
    onClick={onClick}
  >
    <span className="selection-icon" aria-hidden="true"><AppIcon name={icon} size={21} /></span>
    <span className="selection-copy"><strong>{title}</strong><span>{detail}</span></span>
    {trailing ? <span className="selection-trailing">{trailing}</span> : null}
    <span className="selection-check" aria-hidden="true">{selected ? <AppIcon name="check" size={16} /> : null}</span>
  </button>
}

export function NewSessionScreen() {
  const storedHosts = useAppStore((state) => state.hosts)
  const favorites = useAppStore((state) => state.preferences.favorites)
  const toggleFavorite = useAppStore((state) => state.toggleFavorite)
  const hosts = storedHosts.length > 0 ? storedHosts : fixtureMode ? [fixtureHost] : []
  const [step, setStep] = useState<Step>("host")
  const [host, setHost] = useState<RegisteredHost | undefined>(hosts[0])
  const [project, setProject] = useState<ProjectChoice>()
  const [customPath, setCustomPath] = useState("")
  const [model, setModel] = useState("default")
  const [thinking, setThinking] = useState("high")
  const projects = useQuery({
    queryKey: ["projects", host?.hostId],
    queryFn: () => listProjects(host!),
    enabled: Boolean(host) && step === "project",
  })
  const creation = useMutation({
    mutationFn: () => createSession(host!, {
      cwd: project?.path ?? customPath.trim(),
      ...(model !== "default" ? { model } : {}),
      thinkingLevel: thinking,
    }),
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
  const chosenPath = project?.path ?? customPath.trim()
  const chosenLabel = project?.label ?? customPath.split("/").filter(Boolean).at(-1) ?? "작업 폴더"

  return <Shell title={title} onBack={goBack} className="new-session-screen">
    <main className="page-body flow-page">
      <StepProgress step={step} />

      {step === "host" ? <section className="flow-section">
        <header className="flow-intro">
          <span className="flow-intro-icon" aria-hidden="true"><AppIcon name="mac" size={22} /></span>
          <div><h1>어느 Mac에서 시작할까요?</h1><p>세션은 선택한 Mac에서 계속 실행되고, 나중에 터미널에서도 그대로 이어집니다.</p></div>
        </header>
        {hosts.length > 0
          ? <div className="selection-list" role="radiogroup" aria-label="연결된 Mac">{hosts.map((item) => <ChoiceButton
              key={item.hostId}
              selected={host?.hostId === item.hostId}
              title={item.displayName}
              detail={item.ownerLogin}
              icon="mac"
              label={item.displayName}
              trailing="연결됨"
              onClick={() => setHost(item)}
            />)}</div>
          : <EmptyState icon="link" title="연결된 Mac이 없어요" detail="설정에서 Mac을 먼저 연결한 뒤 세션을 시작할 수 있습니다." action={<Button outline onClick={() => navigate("/settings")}>설정 열기</Button>} />}
      </section> : null}

      {step === "project" ? <section className="flow-section">
        <header className="flow-intro">
          <span className="flow-intro-icon" aria-hidden="true"><AppIcon name="folder" size={22} /></span>
          <div><h1>무엇을 이어갈까요?</h1><p>최근 폴더와 즐겨찾기에서 고르거나, Mac의 폴더 경로를 직접 입력하세요.</p></div>
        </header>
        {projects.isLoading
          ? <LoadingCards label="작업 폴더를 불러오는 중" />
          : projects.isError
            ? <div className="surface permission" role="alert">
                <span aria-hidden="true"><AppIcon name="warning" size={22} /></span>
                <div><strong>폴더를 읽을 권한이 없어요.</strong><p>Mac에서 Rubato의 폴더 접근을 허용한 뒤 다시 시도하세요.</p><button className="text-button text-button-inline" type="button" onClick={() => void projects.refetch()}>다시 시도</button></div>
              </div>
            : <div className="selection-list" role="radiogroup" aria-label="작업 폴더">{projects.data?.map((item) => <ChoiceButton
                key={item.path}
                selected={project?.path === item.path}
                title={item.label}
                detail={item.path.replace(/^\/Users\/[^/]+/, "~")}
                icon="folder"
                label={item.label}
                trailing={item.source === "favorite" ? "즐겨찾기" : "최근 사용"}
                onClick={() => { setProject(item); setCustomPath("") }}
              />)}</div>}
        <label className="field custom-path-field">
          <span className="field-label">다른 폴더 경로</span>
          <span className="input-with-icon"><AppIcon name="folder" size={19} /><input
            className="input"
            value={customPath}
            onChange={(event) => { setCustomPath(event.target.value); setProject(undefined) }}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="~/Projects/my-project"
          /></span>
        </label>
      </section> : null}

      {step === "options" ? <section className="flow-section">
        <header className="flow-intro">
          <span className="flow-intro-icon flow-intro-icon-ready" aria-hidden="true"><AppIcon name="check" size={22} /></span>
          <div><h1>시작할 준비가 됐어요.</h1><p>작업 위치와 기본 모델을 확인하면 같은 Rubato 세션이 바로 시작됩니다.</p></div>
        </header>
        <div className="review-card surface">
          <div className="review-project">
            <span className="review-project-icon" aria-hidden="true"><AppIcon name="folder" size={22} /></span>
            <div><span className="review-label">작업 폴더</span><strong>{chosenLabel}</strong><p>{chosenPath}</p></div>
          </div>
          <div className="review-divider" />
          <label className="review-row"><span><AppIcon name="model" size={19} />모델</span><select className="input compact-select" value={model} onChange={(event) => setModel(event.target.value)} aria-label="모델"><option value="default">Mac 기본값</option><option value="gpt-5.6">GPT-5.6</option><option value="claude">Claude</option></select></label>
          <label className="review-row"><span><AppIcon name="brain" size={19} />추론 강도</span><select className="input compact-select" value={thinking} onChange={(event) => setThinking(event.target.value)} aria-label="추론 강도"><option value="low">낮음</option><option value="medium">보통</option><option value="high">높음</option></select></label>
          <label className="favorite-toggle"><Checkbox checked={favorites.includes(favoritePath)} onChange={() => toggleFavorite(favoritePath)} /><span><strong>이 폴더를 즐겨찾기에 추가</strong><small>다음 세션에서 빠르게 선택할 수 있어요.</small></span></label>
        </div>
      </section> : null}

      {creation.isError ? <div className="surface error-box" role="alert"><span className="error-icon" aria-hidden="true"><AppIcon name="warning" size={24} /></span><strong>세션을 시작하지 못했어요.</strong><p>{creation.error.message}</p></div> : null}
    </main>

    <Toolbar className="toolbar-dock app-bottom-dock">
      <ToolbarPane className="toolbar-pane-fill">
        <Button className="toolbar-action" large rounded disabled={!canContinue || creation.isPending} onClick={primary}>
          <span className="button-label">{creation.isPending ? "시작하는 중…" : step === "options" ? <><AppIcon name="spark" size={19} />세션 시작</> : <>계속<AppIcon name="chevron-right" size={18} /></>}</span>
        </Button>
      </ToolbarPane>
    </Toolbar>
  </Shell>
}
